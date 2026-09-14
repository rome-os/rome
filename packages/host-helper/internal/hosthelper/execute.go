package hosthelper

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type output struct {
	// Both exec copy goroutines share the combined byte budget under mu.
	mu        sync.Mutex
	remaining int
	stdout    bytes.Buffer
	stderr    bytes.Buffer
	truncated bool
}

type stream struct {
	output *output
	stderr bool
}

func (w stream) Write(p []byte) (int, error) {
	o := w.output
	o.mu.Lock()
	defer o.mu.Unlock()
	n := min(len(p), o.remaining)
	if n < len(p) {
		o.truncated = true
	}
	if w.stderr {
		o.stderr.Write(p[:n])
	} else {
		o.stdout.Write(p[:n])
	}
	o.remaining -= n
	return len(p), nil
}

func (s *Server) execute(ctx context.Context, job *activeJob) {
	defer s.workers.Done()
	defer job.cancel()
	s.mu.Lock()
	r := job.record
	work, err := os.MkdirTemp(filepath.Join(s.config.StateDir, "work"), r.Request.RequestID+"-")
	if err != nil {
		s.finishLocked(job, ctx, err, nil, nil)
		s.mu.Unlock()
		return
	}
	// Work is private and retained for inspection. Root scripts may put arbitrary
	// files or mounts there, so the daemon never recursively deletes it.
	now := time.Now().UTC()
	r.Snapshot.Status = "running"
	r.Snapshot.StartedAt = &now
	if err = s.save(r); err != nil {
		r.Snapshot.Status = "unknown"
		r.Snapshot.FinishedAt = &now
		s.uncertain = r
		s.storageFault()
		s.active = nil
		s.mu.Unlock()
		return
	}
	o := &output{remaining: s.config.MaxOutputBytes}
	job.output = o
	alive, lifetime, err := os.Pipe()
	if err != nil {
		s.finishLocked(job, ctx, err, nil, o)
		s.mu.Unlock()
		return
	}
	defer lifetime.Close()
	cmd := exec.Command("/proc/self/exe", "--supervise", r.Request.Interpreter)
	cmd.ExtraFiles = []*os.File{alive, s.executionLease}
	cmd.Dir = work
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "HOME=" + work, "TMPDIR=" + work, "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
	cmd.Stdin = strings.NewReader(r.Request.Script)
	cmd.Stdout = stream{output: o}
	cmd.Stderr = stream{output: o, stderr: true}
	// With no CommandContext, WaitDelay bounds output drain only after supervisor
	// exit. A deadline must close liveness, never kill the supervisor during cleanup.
	cmd.WaitDelay = 250 * time.Millisecond
	err = ctx.Err()
	if err == nil {
		err = cmd.Start()
	}
	alive.Close()
	s.mu.Unlock()
	if err == nil {
		finished := make(chan struct{})
		go func() {
			select {
			case <-ctx.Done():
				lifetime.Close()
			case <-finished:
			}
		}()
		err = cmd.Wait()
		close(finished)
		if errors.Is(err, exec.ErrWaitDelay) {
			o.mu.Lock()
			o.truncated = true
			o.mu.Unlock()
			err = nil
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finishLocked(job, ctx, err, cmd, o)
}

func (s *Server) finishLocked(job *activeJob, ctx context.Context, err error, cmd *exec.Cmd, o *output) {
	r := job.record
	now := time.Now().UTC()
	r.Snapshot.FinishedAt = &now
	r.Snapshot.Status = "succeeded"
	if err != nil {
		r.Snapshot.Status = "failed"
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		r.Snapshot.Status = "timed_out"
	} else if job.cancelled {
		r.Snapshot.Status = "cancelled"
	}
	if cmd != nil && cmd.ProcessState != nil {
		exit := cmd.ProcessState.ExitCode()
		r.Snapshot.ExitCode = &exit
	}
	if o != nil {
		o.copyTo(&r.Snapshot)
	}
	if err := s.save(r); err != nil {
		r.Snapshot.Status = "unknown"
		r.Snapshot.ExitCode = nil
		s.uncertain = r
		s.storageFault()
	}
	s.audit("finished", r)
	s.active = nil
}

func (o *output) copyTo(snapshot *Snapshot) {
	o.mu.Lock()
	defer o.mu.Unlock()
	snapshot.Stdout = strings.ToValidUTF8(o.stdout.String(), "?")
	snapshot.Stderr = strings.ToValidUTF8(o.stderr.String(), "?")
	snapshot.Truncated = o.truncated
}

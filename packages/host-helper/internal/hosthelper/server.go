package hosthelper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type activeJob struct {
	record    *record
	output    *output
	cancel    context.CancelFunc
	cancelled bool
}

type Server struct {
	syncStateDir func(string) error
	config       Config
	version      string
	logger       *slog.Logger
	// mu guards jobs, active, closing, and fault. Persistence and process launch
	// share this lock so cancellation and duplicate submission cannot cross intent.
	// Snapshot reads take output.mu after mu. Output writers never take mu.
	mu             sync.Mutex
	jobs           map[string]struct{}
	active         *activeJob
	uncertain      *record
	closing        bool
	fault          bool
	workers        sync.WaitGroup
	locks          []*os.File
	executionLease *os.File
	listener       *net.UnixListener
	http           *http.Server
	closeOnce      sync.Once
}

// New holds state and socket locks until Close. It waits for surviving job
// cleanup before recovery. Call Serve once.
func New(config Config, version string, logger *slog.Logger) (_ *Server, err error) {
	config.defaults()
	if err = config.validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	}
	s := &Server{syncStateDir: syncDir, config: config, version: version, logger: logger, jobs: map[string]struct{}{}}
	defer func() {
		if err != nil {
			for _, lock := range s.locks {
				lock.Close()
			}
		}
	}()
	if err = privateDir(config.StateDir, 0700); err != nil {
		return nil, err
	}
	lock, err := lockFile(filepath.Join(config.StateDir, ".lock"))
	if err != nil {
		return nil, err
	}
	s.locks = append(s.locks, lock)
	// The daemon lock excludes another live server. A surviving supervisor keeps
	// executionLease until its process group is killed and reaped, before recovery.
	s.executionLease, err = lockFileMode(filepath.Join(config.StateDir, ".execution.lock"), syscall.LOCK_EX)
	if err != nil {
		return nil, err
	}
	s.locks = append(s.locks, s.executionLease)
	if err = privateDir(filepath.Join(config.StateDir, "jobs"), 0700); err != nil {
		return nil, err
	}
	if err = privateDir(filepath.Join(config.StateDir, "work"), 0700); err != nil {
		return nil, err
	}
	if err = syncDir(config.StateDir); err != nil {
		return nil, err
	}
	if err = s.recover(); err != nil {
		return nil, err
	}
	socketDir := filepath.Dir(config.SocketPath)
	if err = privateDir(socketDir, 0755); err != nil {
		return nil, err
	}
	lock, err = lockFile(filepath.Join(socketDir, ".rome-host.lock"))
	if err != nil {
		return nil, err
	}
	s.locks = append(s.locks, lock)
	if info, statErr := os.Lstat(config.SocketPath); statErr == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("socket path exists and is not a socket")
		}
		connection, dialErr := net.DialTimeout("unix", config.SocketPath, 200*time.Millisecond)
		if dialErr == nil {
			connection.Close()
			return nil, errors.New("socket has a live listener")
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return nil, errors.New("cannot establish whether socket is stale")
		}
		if err = os.Remove(config.SocketPath); err != nil {
			return nil, err
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, statErr
	}
	s.listener, err = net.ListenUnix("unix", &net.UnixAddr{Name: config.SocketPath, Net: "unix"})
	if err != nil {
		return nil, err
	}
	s.listener.SetUnlinkOnClose(false)
	defer func() {
		if err != nil {
			s.listener.Close()
			os.Remove(config.SocketPath)
		}
	}()
	if err = os.Chmod(config.SocketPath, 0660); err != nil {
		return nil, err
	}
	if err = os.Chown(config.SocketPath, os.Geteuid(), config.SocketGID); err != nil {
		return nil, err
	}
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	return s, nil
}

func (s *Server) Serve() error {
	err := s.http.Serve(&limitedListener{Listener: s.listener, slots: make(chan struct{}, 64)})
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

// Close rejects new jobs, cancels the managed process group, and persists its
// outcome before releasing locks. Root scripts can escape the process group.
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closing = true
		if s.active != nil {
			s.active.cancelled = true
			s.active.cancel()
		}
		s.mu.Unlock()
		s.http.Close()
		s.listener.Close()
		s.workers.Wait()
		os.Remove(s.config.SocketPath)
		for _, lock := range s.locks {
			lock.Close()
		}
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func apiError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.RawQuery != "" {
		apiError(w, 400, "invalid_request", "query parameters are not supported")
		return
	}
	if req.Method == "GET" && req.URL.Path == "/v1/capabilities" {
		writeJSON(w, 200, map[string]any{"protocolVersion": 1, "version": s.version, "hostId": s.config.HostID, "platform": "linux", "enabled": s.config.Enabled, "interpreters": []string{"sh", "bash"}, "maxTimeoutSeconds": s.config.MaxTimeoutSeconds, "maxOutputBytes": s.config.MaxOutputBytes})
		return
	}
	if req.Method == "POST" && req.URL.Path == "/v1/jobs" {
		s.submit(w, req)
		return
	}
	parts := strings.Split(strings.TrimPrefix(req.URL.Path, "/v1/jobs/"), "/")
	if !strings.HasPrefix(req.URL.Path, "/v1/jobs/") || !identifier.MatchString(parts[0]) {
		apiError(w, 404, "not_found", "unknown endpoint")
		return
	}
	cancel := len(parts) == 2 && parts[1] == "cancel" && req.Method == "POST"
	if !cancel && !(len(parts) == 1 && req.Method == "GET") {
		apiError(w, 404, "not_found", "unknown endpoint")
		return
	}
	if cancel {
		body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 1))
		if err != nil || len(body) != 0 {
			apiError(w, 400, "invalid_request", "cancel requires an empty body")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := parts[0]
	if _, ok := s.jobs[id]; !ok {
		apiError(w, 404, "not_found", "unknown job")
		return
	}
	if s.active != nil && s.active.record.Request.RequestID == id {
		if cancel {
			s.active.cancelled = true
			s.active.cancel()
		}
		writeJSON(w, 200, s.snapshot(s.active.record))
		return
	}
	if s.uncertain != nil && s.uncertain.Request.RequestID == id {
		writeJSON(w, 200, s.uncertain.Snapshot)
		return
	}
	r, err := s.read(id)
	if err != nil {
		s.storageFault()
		apiError(w, 503, "state_unavailable", "durable job state unavailable")
		return
	}
	writeJSON(w, 200, r.Snapshot)
}

func (s *Server) submit(w http.ResponseWriter, req *http.Request) {
	if !s.config.Enabled {
		apiError(w, 403, "disabled", "host execution is disabled")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, req.Body, maxBodyBytes))
	if err != nil {
		apiError(w, 400, "invalid_request", "request body exceeds the host limit")
		return
	}
	var request Request
	if err = strictJSON(body, &request, requestFields); err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	if err = request.validate(); err != nil {
		apiError(w, 400, "invalid_request", err.Error())
		return
	}
	if request.HostID != s.config.HostID {
		apiError(w, 409, "host_mismatch", "hostId does not match this host")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.jobs[request.RequestID]; ok {
		var r *record
		if s.active != nil && s.active.record.Request.RequestID == request.RequestID {
			r = s.active.record
		} else if s.uncertain != nil && s.uncertain.Request.RequestID == request.RequestID {
			r = s.uncertain
		} else {
			r, err = s.read(request.RequestID)
		}
		if err != nil {
			s.storageFault()
			apiError(w, 503, "state_unavailable", "durable job state unavailable")
			return
		}
		if r.Request != request {
			apiError(w, 409, "request_conflict", "requestId already belongs to a different request")
			return
		}
		writeJSON(w, 200, s.snapshot(r))
		return
	}
	if request.TimeoutSeconds > s.config.MaxTimeoutSeconds {
		apiError(w, 400, "invalid_request", "timeoutSeconds is outside the host limit")
		return
	}
	if s.closing || s.fault {
		apiError(w, 503, "unavailable", "daemon is stopping or durable state is unavailable")
		return
	}
	if s.active != nil {
		apiError(w, 503, "busy", "another host job is active")
		return
	}
	if len(s.jobs) >= maxJobs {
		apiError(w, 503, "retention_limit", "10000 durable job IDs retained; preserve records to retain deduplication")
		return
	}
	r := newRecord(request)
	// Reserve the ID even if fsync fails after rename. No uncertain intent may run.
	s.jobs[request.RequestID] = struct{}{}
	if err = s.save(r); err != nil {
		now := time.Now().UTC()
		r.Snapshot.Status = "unknown"
		r.Snapshot.FinishedAt = &now
		s.uncertain = r
		s.storageFault()
		apiError(w, 503, "state_unavailable", "could not persist job intent")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(request.TimeoutSeconds)*time.Second)
	s.active = &activeJob{record: r, cancel: cancel}
	s.workers.Add(1)
	s.audit("accepted", r)
	go s.execute(ctx, s.active)
	writeJSON(w, 202, r.Snapshot)
}

func (s *Server) storageFault() {
	s.fault = true
	s.logger.Error("host helper durable state unavailable")
}

func (s *Server) snapshot(r *record) Snapshot {
	snapshot := r.Snapshot
	if s.active != nil && s.active.record == r && s.active.output != nil {
		s.active.output.copyTo(&snapshot)
	}
	return snapshot
}

func (s *Server) audit(event string, r *record) {
	s.logger.Info("host execution", "event", event, "requestId", r.Request.RequestID, "hostId", r.Request.HostID, "executionId", r.Request.ExecutionID, "rootExecutionId", r.Request.RootExecutionID, "scriptSha256", r.Snapshot.ScriptSHA256, "status", r.Snapshot.Status)
}

package hosthelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

type Request struct {
	RequestID       string `json:"requestId"`
	HostID          string `json:"hostId"`
	Interpreter     string `json:"interpreter"`
	Script          string `json:"script"`
	Reason          string `json:"reason"`
	TimeoutSeconds  int    `json:"timeoutSeconds"`
	ExecutionID     string `json:"executionId"`
	RootExecutionID string `json:"rootExecutionId"`
}

var requestFields = []string{"requestId", "hostId", "interpreter", "script", "reason", "timeoutSeconds", "executionId", "rootExecutionId"}

func (r Request) validate() error {
	if !identifier.MatchString(r.RequestID) {
		return errors.New("invalid requestId")
	}
	if r.Interpreter != "sh" && r.Interpreter != "bash" {
		return errors.New("interpreter must be sh or bash")
	}
	if len(r.Script) == 0 || len(r.Script) > 64*1024 || strings.ContainsRune(r.Script, 0) || !utf8.ValidString(r.Script) {
		return errors.New("script must be 1..65536 UTF-8 bytes without NUL")
	}
	if strings.TrimSpace(r.Reason) == "" || utf8.RuneCountInString(r.Reason) > 2000 {
		return errors.New("reason must be 1..2000 characters")
	}
	if len(r.ExecutionID) == 0 || len(r.ExecutionID) > 256 || len(r.RootExecutionID) == 0 || len(r.RootExecutionID) > 256 {
		return errors.New("execution IDs must be 1..256 bytes")
	}
	if r.TimeoutSeconds < 1 || r.TimeoutSeconds > 600 {
		return errors.New("timeoutSeconds must be 1..600")
	}
	return nil
}

type Snapshot struct {
	ID           string     `json:"id"`
	RequestID    string     `json:"requestId"`
	HostID       string     `json:"hostId"`
	ScriptSHA256 string     `json:"scriptSha256"`
	Status       string     `json:"status"`
	ExitCode     *int       `json:"exitCode"`
	Stdout       string     `json:"stdout"`
	Stderr       string     `json:"stderr"`
	Truncated    bool       `json:"truncated"`
	StartedAt    *time.Time `json:"startedAt"`
	FinishedAt   *time.Time `json:"finishedAt"`
}

type record struct {
	Request  Request  `json:"request"`
	Snapshot Snapshot `json:"snapshot"`
}

func newRecord(r Request) *record {
	hash := sha256.Sum256([]byte(r.Script))
	return &record{Request: r, Snapshot: Snapshot{ID: r.RequestID, RequestID: r.RequestID, HostID: r.HostID, ScriptSHA256: hex.EncodeToString(hash[:]), Status: "queued"}}
}

func lockFile(path string) (*os.File, error) {
	return lockFileMode(path, syscall.LOCK_EX|syscall.LOCK_NB)
}

func lockFileMode(path string, mode int) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err = protectedFile(path); err == nil {
		err = syscall.Flock(int(f.Fd()), mode)
	}
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("cannot lock %s: %w", path, err)
	}
	return f, nil
}

func privateDir(path string, mode os.FileMode) error {
	var created []string
	for parent := path; ; parent = filepath.Dir(parent) {
		_, err := os.Lstat(parent)
		if err == nil {
			if err := protectedPath(parent); err != nil {
				return err
			}
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		created = append(created, parent)
	}
	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	if err := protectedPath(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat := info.Sys().(*syscall.Stat_t)
	if int(stat.Uid) != os.Geteuid() || info.Mode().Perm()&0022 != 0 {
		return fmt.Errorf("directory must be owned by daemon UID without group/world write: %s", path)
	}
	if err := os.Chmod(path, mode); err != nil {
		return err
	}
	// Persist every new ancestor entry before any job intent can depend on it.
	for _, directory := range created {
		if err := syncDir(directory); err != nil {
			return err
		}
		if err := syncDir(filepath.Dir(directory)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) recordPath(id string) string {
	return filepath.Join(s.config.StateDir, "jobs", id+".json")
}

func (s *Server) save(r *record) error {
	dir := filepath.Dir(s.recordPath(r.Request.RequestID))
	f, err := os.CreateTemp(dir, ".intent-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = json.NewEncoder(f).Encode(r); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), s.recordPath(r.Request.RequestID)); err != nil {
		return err
	}
	return s.syncStateDir(dir)
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func (s *Server) read(id string) (*record, error) {
	path := s.recordPath(id)
	if err := protectedFile(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var r record
	d := json.NewDecoder(io.LimitReader(f, 8*1024*1024))
	d.DisallowUnknownFields()
	if err = d.Decode(&r); err != nil {
		return nil, err
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("trailing state data")
	}
	expected := newRecord(r.Request).Snapshot
	if r.Request.RequestID != id || r.Snapshot.ID != id || r.Snapshot.RequestID != id || r.Snapshot.HostID != r.Request.HostID || r.Snapshot.ScriptSHA256 != expected.ScriptSHA256 {
		return nil, errors.New("inconsistent state record")
	}
	switch r.Snapshot.Status {
	case "queued", "running", "succeeded", "failed", "cancelled", "timed_out", "unknown":
	default:
		return nil, errors.New("invalid persisted status")
	}
	return &r, nil
}

func (s *Server) recover() error {
	dir := filepath.Join(s.config.StateDir, "jobs")
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	for {
		entries, err := f.ReadDir(100)
		if err != nil && err != io.EOF {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".intent-") {
				if err := os.Remove(filepath.Join(dir, name)); err != nil {
					return err
				}
				continue
			}
			id := strings.TrimSuffix(name, ".json")
			if name != id+".json" || !identifier.MatchString(id) {
				return errors.New("unexpected state entry")
			}
			if len(s.jobs) >= maxJobs {
				return errors.New("state exceeds retained job limit")
			}
			r, err := s.read(id)
			if err != nil {
				return fmt.Errorf("recover %s: %w", id, err)
			}
			if r.Snapshot.Status == "queued" || r.Snapshot.Status == "running" {
				now := time.Now().UTC()
				r.Snapshot.Status = "unknown"
				r.Snapshot.FinishedAt = &now
				r.Snapshot.ExitCode = nil
				if err = s.save(r); err != nil {
					return err
				}
				s.audit("recovered", r)
			}
			s.jobs[id] = struct{}{}
		}
		if err == io.EOF {
			return nil
		}
	}
}

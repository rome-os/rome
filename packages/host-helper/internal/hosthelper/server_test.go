package hosthelper

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	dir := t.TempDir()
	return Config{HostID: "host-1", Enabled: true, SocketPath: filepath.Join(dir, "run", "control.sock"), StateDir: filepath.Join(dir, "state"), SocketGID: os.Getegid(), MaxTimeoutSeconds: 3, MaxOutputBytes: 1024}
}

func startServer(t *testing.T, c Config) (*Server, *http.Client) {
	t.Helper()
	s, err := New(c, "0.1.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		if err := s.Serve(); err != nil {
			t.Error(err)
		}
	}()
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.SocketPath)
	}}
	client := &http.Client{Transport: transport, Timeout: 8 * time.Second}
	t.Cleanup(func() { transport.CloseIdleConnections(); s.Close() })
	return s, client
}

func request(id, script string) Request {
	return Request{RequestID: id, HostID: "host-1", Interpreter: "sh", Script: script, Reason: "test", TimeoutSeconds: 3, ExecutionID: "execution-1", RootExecutionID: "root-1"}
}

func call(t *testing.T, c *http.Client, method, path string, body any) (int, []byte) {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	return rawCall(t, c, method, path, data)
}

func rawCall(t *testing.T, c *http.Client, method, path string, data []byte) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, "http://unix"+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, b
}

func waitJob(t *testing.T, c *http.Client, id string) Snapshot {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		status, data := call(t, c, "GET", "/v1/jobs/"+id, nil)
		if status != 200 {
			t.Fatalf("GET: %d %s", status, data)
		}
		var snapshot Snapshot
		if err := json.Unmarshal(data, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Status != "running" && snapshot.Status != "queued" {
			return snapshot
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return Snapshot{}
}

func submit(t *testing.T, c *http.Client, r Request) {
	t.Helper()
	status, data := call(t, c, "POST", "/v1/jobs", r)
	if status != 202 {
		t.Fatalf("submit: %d %s", status, data)
	}
}

func TestUDSExecutionAndPersistence(t *testing.T) {
	c := testConfig(t)
	s, client := startServer(t, c)
	t.Setenv("HOST_HELPER_SECRET", "secret")
	info, err := os.Stat(c.SocketPath)
	if err != nil || info.Mode().Perm() != 0660 {
		t.Fatalf("socket permissions: %v %v", info, err)
	}
	status, body := call(t, client, "GET", "/v1/capabilities", nil)
	if status != 200 || !bytes.Contains(body, []byte(`"version":"0.1.0"`)) {
		t.Fatalf("capabilities %d %s", status, body)
	}
	r := request("first", "printf 'hello'; printf 'error' >&2; test -z \"${HOST_HELPER_SECRET:-}\"; exit 7")
	submit(t, client, r)
	got := waitJob(t, client, r.RequestID)
	if got.Status != "failed" || got.ExitCode == nil || *got.ExitCode != 7 || got.Stdout != "hello" || got.Stderr != "error" || got.StartedAt == nil || got.FinishedAt == nil {
		t.Fatalf("snapshot: %+v", got)
	}
	s.Close()
	_, client2 := startServer(t, c)
	status, body = call(t, client2, "POST", "/v1/jobs", r)
	if status != 200 {
		t.Fatalf("duplicate after restart: %d %s", status, body)
	}
	if restored := waitJob(t, client2, r.RequestID); restored.ScriptSHA256 != got.ScriptSHA256 || restored.Stdout != got.Stdout || restored.Status != got.Status {
		t.Fatalf("recovered snapshot: %+v", restored)
	}
	submit(t, client2, request("environment", "test -z \"${HOST_HELPER_SECRET:-}\" && printf clean"))
	if got := waitJob(t, client2, "environment"); got.Status != "succeeded" || got.Stdout != "clean" {
		t.Fatalf("environment: %+v", got)
	}
}

func TestStrictRequestsAndDisabled(t *testing.T) {
	c := testConfig(t)
	_, client := startServer(t, c)
	r := request("invalid", "true")
	b, _ := json.Marshal(r)
	tests := [][]byte{
		[]byte(`null`), []byte(`{}`), []byte(`[]`), append(append([]byte{}, b...), []byte(` {}`)...),
		bytes.Replace(b, []byte(`"requestId":"invalid"`), []byte(`"requestId":"invalid","requestId":"invalid"`), 1),
		bytes.Replace(b, []byte(`"requestId"`), []byte(`"RequestId"`), 1),
		bytes.Replace(b, []byte(`"script":"true"`), []byte(`"script":null`), 1),
		bytes.Replace(b, []byte(`"script":"true"`), []byte(`"script":"true","cwd":"/"`), 1),
		bytes.Repeat([]byte("x"), maxBodyBytes+1),
	}
	for i, b := range tests {
		if status, data := rawCall(t, client, "POST", "/v1/jobs", b); status != 400 {
			t.Fatalf("case %d: %d %s", i, status, data)
		}
	}
	for _, modify := range []func(*Request){
		func(r *Request) { r.RequestID = "../escape" }, func(r *Request) { r.Interpreter = "python" }, func(r *Request) { r.TimeoutSeconds = 0 },
		func(r *Request) { r.TimeoutSeconds = 4 }, func(r *Request) { r.Script = strings.Repeat("x", 65537) }, func(r *Request) { r.Reason = strings.Repeat("x", 2001) },
		func(r *Request) { r.Script = "\x00" }, func(r *Request) { r.ExecutionID = "" },
	} {
		r := request("invalid", "true")
		modify(&r)
		if status, data := call(t, client, "POST", "/v1/jobs", r); status != 400 {
			t.Fatalf("invalid input: %d %s", status, data)
		}
	}
	r.HostID = "other"
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 409 {
		t.Fatal(status)
	}
	c2 := testConfig(t)
	c2.Enabled = false
	_, disabled := startServer(t, c2)
	if status, _ := call(t, disabled, "POST", "/v1/jobs", request("denied", "true")); status != 403 {
		t.Fatal(status)
	}
}

func TestConcurrentDuplicatesBusyAndConflict(t *testing.T) {
	_, client := startServer(t, testConfig(t))
	r := request("duplicate", "sleep 0.4; printf once")
	var wg sync.WaitGroup
	statuses := make(chan int, 20)
	for range 20 {
		wg.Add(1)
		go func() { defer wg.Done(); status, _ := call(t, client, "POST", "/v1/jobs", r); statuses <- status }()
	}
	wg.Wait()
	close(statuses)
	accepted := 0
	for status := range statuses {
		if status == 202 {
			accepted++
		} else if status != 200 {
			t.Fatal(status)
		}
	}
	if accepted != 1 {
		t.Fatalf("launched %d jobs", accepted)
	}
	if status, _ := call(t, client, "POST", "/v1/jobs", request("busy", "true")); status != 503 {
		t.Fatal(status)
	}
	r.Reason = "different"
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 409 {
		t.Fatal(status)
	}
	if got := waitJob(t, client, r.RequestID); got.Stdout != "once" {
		t.Fatalf("%+v", got)
	}
}

func TestTimeoutCancellationOutputAndOrphanPipes(t *testing.T) {
	_, client := startServer(t, testConfig(t))
	r := request("timeout", "sleep 20 & wait")
	r.TimeoutSeconds = 1
	submit(t, client, r)
	if got := waitJob(t, client, r.RequestID); got.Status != "timed_out" {
		t.Fatalf("%+v", got)
	}
	submit(t, client, request("cancel", "sleep 20 & wait"))
	for range 2 {
		if status, _ := call(t, client, "POST", "/v1/jobs/cancel/cancel", nil); status != 200 {
			t.Fatal(status)
		}
	}
	if got := waitJob(t, client, "cancel"); got.Status != "cancelled" {
		t.Fatalf("%+v", got)
	}
	submit(t, client, request("flood", "head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2"))
	if got := waitJob(t, client, "flood"); got.Status != "succeeded" || !got.Truncated || len(got.Stdout)+len(got.Stderr) != 1024 {
		t.Fatalf("flood status=%s truncated=%v bytes=%d", got.Status, got.Truncated, len(got.Stdout)+len(got.Stderr))
	}
	start := time.Now()
	submit(t, client, request("orphan", "sleep 20 & printf done"))
	if got := waitJob(t, client, "orphan"); got.Stdout != "done" || time.Since(start) > 2*time.Second {
		t.Fatalf("orphan: %+v", got)
	}
	submit(t, client, request("after-orphan", "printf next"))
	if got := waitJob(t, client, "after-orphan"); got.Status != "succeeded" {
		t.Fatalf("%+v", got)
	}
}

func TestRunningSnapshotIncludesBoundedOutput(t *testing.T) {
	_, client := startServer(t, testConfig(t))
	r := request("live", "printf progress; printf warning >&2; sleep 20")
	submit(t, client, r)
	deadline := time.Now().Add(time.Second)
	for {
		_, data := call(t, client, "GET", "/v1/jobs/live", nil)
		var snapshot Snapshot
		if err := json.Unmarshal(data, &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Stdout == "progress" && snapshot.Stderr == "warning" {
			if snapshot.Status != "running" {
				t.Fatalf("%+v", snapshot)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("live output absent: %+v", snapshot)
		}
		time.Sleep(time.Millisecond)
	}
	status, data := call(t, client, "POST", "/v1/jobs", r)
	if status != 200 || !bytes.Contains(data, []byte(`"stdout":"progress"`)) {
		t.Fatalf("duplicate snapshot: %d %s", status, data)
	}
	call(t, client, "POST", "/v1/jobs/live/cancel", nil)
	waitJob(t, client, r.RequestID)
}

func TestRecoveryNeverRelaunchesIntent(t *testing.T) {
	c := testConfig(t)
	s, client := startServer(t, c)
	r := request("interrupted", "printf should-not-run")
	record := newRecord(r)
	record.Snapshot.Status = "running"
	if err := s.save(record); err != nil {
		t.Fatal(err)
	}
	s.Close()
	_, client = startServer(t, c)
	if got := waitJob(t, client, r.RequestID); got.Status != "unknown" || got.Stdout != "" || got.ExitCode != nil {
		t.Fatalf("%+v", got)
	}
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 200 {
		t.Fatal(status)
	}
	if got := waitJob(t, client, r.RequestID); got.Status != "unknown" {
		t.Fatalf("%+v", got)
	}
}

func TestShutdownAndSingleDaemonLock(t *testing.T) {
	c := testConfig(t)
	s, client := startServer(t, c)
	if other, err := New(c, "test", nil); err == nil {
		other.Close()
		t.Fatal("second daemon acquired state lock")
	}
	otherConfig := c
	otherConfig.StateDir = filepath.Join(t.TempDir(), "state")
	if other, err := New(otherConfig, "test", nil); err == nil {
		other.Close()
		t.Fatal("second daemon acquired socket lock")
	}
	submit(t, client, request("shutdown", "sleep 30 & wait"))
	start := time.Now()
	s.Close()
	if time.Since(start) > 2*time.Second {
		t.Fatal("shutdown hung")
	}
	if info, err := os.Stat(filepath.Dir(c.SocketPath)); err != nil || !info.IsDir() {
		t.Fatal("socket directory removed")
	}
	c.Enabled = false
	_, client = startServer(t, c)
	if got := waitJob(t, client, "shutdown"); got.Status != "cancelled" {
		t.Fatalf("%+v", got)
	}
	if status, _ := call(t, client, "POST", "/v1/jobs/shutdown/cancel", nil); status != 200 {
		t.Fatal(status)
	}
}

func TestLiveForeignListenerIsNotRemoved(t *testing.T) {
	c := testConfig(t)
	if err := os.MkdirAll(filepath.Dir(c.SocketPath), 0755); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("unix", c.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if s, err := New(c, "test", nil); err == nil {
		s.Close()
		t.Fatal("replaced live listener")
	}
	conn, err := net.Dial("unix", c.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

func TestConfigProtectionAndStrictDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	write := func(body string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"hostId":"host","socketGid":0}`)
	c, err := LoadConfig(path)
	if err != nil || c.Enabled || c.MaxOutputBytes != 131072 || c.MaxTimeoutSeconds != 600 {
		t.Fatalf("%+v %v", c, err)
	}
	for _, body := range []string{`{"hostId":"host"}`, `{"hostId":"host","socketGid":null}`, `{"hostId":"host","socketGid":0,"enabled":true,"enabled":false}`, `{"hostId":"host","socketGid":0,"maxOutputBytes":0}`, `{"hostId":"host","socketGid":0,"maxOutputBytes":131073}`} {
		write(body)
		if _, err := LoadConfig(path); err == nil {
			t.Fatal("accepted invalid config", body)
		}
	}
	write(`{"hostId":"host","socketGid":0}`)
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); err == nil {
		t.Fatal("accepted writable config")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "symlink.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(link); err == nil {
		t.Fatal("accepted symlink config")
	}
	if _, err := LoadConfig(dir + "/./config.json"); err == nil {
		t.Fatal("accepted noncanonical config path")
	}
}

func TestDuplicateSurvivesTighterTimeoutPolicy(t *testing.T) {
	c := testConfig(t)
	s, client := startServer(t, c)
	r := request("policy-change", "true")
	submit(t, client, r)
	waitJob(t, client, r.RequestID)
	s.Close()
	c.MaxTimeoutSeconds = 1
	_, client = startServer(t, c)
	if status, data := call(t, client, "POST", "/v1/jobs", r); status != 200 {
		t.Fatalf("%d %s", status, data)
	}
	r.RequestID = "new-job"
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 400 {
		t.Fatal(status)
	}
}

func TestRetentionLimitKeepsDuplicateIdentity(t *testing.T) {
	s, client := startServer(t, testConfig(t))
	r := request("retained", "true")
	submit(t, client, r)
	waitJob(t, client, r.RequestID)
	s.mu.Lock()
	for i := 1; i < maxJobs; i++ {
		s.jobs["reserved-"+strconv.Itoa(i)] = struct{}{}
	}
	s.mu.Unlock()
	if status, data := call(t, client, "POST", "/v1/jobs", request("overflow", "true")); status != 503 || !bytes.Contains(data, []byte("retention_limit")) {
		t.Fatalf("%d %s", status, data)
	}
	if status, data := call(t, client, "POST", "/v1/jobs", r); status != 200 {
		t.Fatalf("%d %s", status, data)
	}
	r.Script = "printf different"
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 409 {
		t.Fatal(status)
	}
}

func TestFailedTerminalPersistenceReturnsUnknownAndStopsAdmission(t *testing.T) {
	c := testConfig(t)
	s, client := startServer(t, c)
	marker := filepath.Join(t.TempDir(), "release")
	r := request("disk-failure", "while [ ! -f '"+marker+"' ]; do sleep 0.01; done; printf complete")
	submit(t, client, r)
	deadline := time.Now().Add(time.Second)
	for {
		_, data := call(t, client, "GET", "/v1/jobs/"+r.RequestID, nil)
		if bytes.Contains(data, []byte(`"status":"running"`)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job did not start")
		}
		time.Sleep(time.Millisecond)
	}
	jobs := filepath.Join(c.StateDir, "jobs")
	if err := os.Rename(jobs, jobs+"-backup"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(jobs, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, nil, 0600); err != nil {
		t.Fatal(err)
	}
	got := waitJob(t, client, r.RequestID)
	if got.Status != "unknown" || got.Stdout != "complete" {
		t.Fatalf("%+v", got)
	}
	if status, _ := call(t, client, "POST", "/v1/jobs", r); status != 200 {
		t.Fatal(status)
	}
	if status, _ := call(t, client, "POST", "/v1/jobs", request("next", "true")); status != 503 {
		t.Fatal(status)
	}
	s.Close()
	if err := os.Remove(jobs); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(jobs+"-backup", jobs); err != nil {
		t.Fatal(err)
	}
	_, client = startServer(t, c)
	if got := waitJob(t, client, r.RequestID); got.Status != "unknown" {
		t.Fatalf("%+v", got)
	}
}

func TestCrashDaemonProcess(t *testing.T) {
	path := os.Getenv("ROME_HELPER_CRASH_TEST_CONFIG")
	if path == "" {
		return
	}
	c, err := LoadConfig(path)
	if err != nil {
		panic(err)
	}
	s, err := New(c, "test", nil)
	if err != nil {
		panic(err)
	}
	if err := s.Serve(); err != nil {
		panic(err)
	}
	os.Exit(0)
}

func TestAbruptDaemonDeathRecoversUnknown(t *testing.T) {
	c := testConfig(t)
	configPath := filepath.Join(t.TempDir(), "config.json")
	b, _ := json.Marshal(c)
	if err := os.WriteFile(configPath, b, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashDaemonProcess$")
	cmd.Env = append(os.Environ(), "ROME_HELPER_CRASH_TEST_CONFIG="+configPath)
	var log bytes.Buffer
	cmd.Stdout = &log
	cmd.Stderr = &log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	deadline := time.Now().Add(3 * time.Second)
	for {
		if conn, err := net.Dial("unix", c.SocketPath); err == nil {
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child daemon did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.SocketPath)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	pidFile := filepath.Join(t.TempDir(), "pid")
	r := request("crash", "printf '%s' $$ > '"+pidFile+"'; sleep 20")
	submit(t, client, r)
	var pid int
	for {
		if data, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(string(data))
			if pid > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("job did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer syscall.Kill(-pid, syscall.SIGKILL)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	// A crashed daemon cannot attest the root script stopped. The test owns and
	// kills this process group independently before inspecting durable recovery.
	syscall.Kill(-pid, syscall.SIGKILL)
	_, restarted := startServer(t, c)
	if got := waitJob(t, restarted, r.RequestID); got.Status != "unknown" {
		t.Fatalf("%+v", got)
	}
	if status, _ := call(t, restarted, "POST", "/v1/jobs", r); status != 200 {
		t.Fatal(status)
	}
	if got := waitJob(t, restarted, r.RequestID); got.Status != "unknown" {
		t.Fatalf("%+v", got)
	}
}

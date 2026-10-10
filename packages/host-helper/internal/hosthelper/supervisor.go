package hosthelper

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
)

// RunSupervisor handles the internal --supervise invocation and exits. Call it
// before parsing daemon flags. Other invocations return without side effects.
func RunSupervisor() {
	if len(os.Args) != 3 || os.Args[1] != "--supervise" {
		return
	}
	os.Exit(supervise(os.Args[2]))
}

func supervise(interpreter string) int {
	if interpreter != "sh" && interpreter != "bash" {
		return 1
	}
	alive := os.NewFile(3, "daemon-liveness")
	lease := os.NewFile(4, "execution-lease")
	defer alive.Close()
	defer lease.Close()
	// Only the supervisor retains these descriptors. The shell cannot keep the
	// liveness pipe or startup barrier open by inheriting them.
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	// PR_SET_CHILD_SUBREAPER makes orphaned grandchildren waitable here, including
	// when the shell exits before its background children. No host service is needed.
	if _, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0); errno != 0 {
		return 1
	}
	dead := make(chan struct{})
	go func() { io.Copy(io.Discard, alive); close(dead) }()
	cmd := exec.Command("/bin/"+interpreter, "-s")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return 1
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-dead:
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-done
	}
	syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	// Reap before releasing lease so recovery cannot admit work while ordinary
	// descendants still run. Root code can escape this group or kill its supervisor.
	for {
		_, waitErr := syscall.Wait4(-cmd.Process.Pid, nil, 0, nil)
		if errors.Is(waitErr, syscall.EINTR) {
			continue
		}
		if waitErr != nil {
			break
		}
	}
	if err != nil {
		if code := cmd.ProcessState.ExitCode(); code >= 0 {
			return code
		}
		return 1
	}
	return 0
}

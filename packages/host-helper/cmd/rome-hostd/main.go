package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/rome-os/rome/packages/host-helper/internal/hosthelper"
)

var version = "dev"

func main() {
	hosthelper.RunSupervisor()
	configPath := flag.String("config", "/etc/rome-host/config.json", "protected host config file")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if flag.NArg() != 0 {
		logger.Error("unexpected arguments")
		os.Exit(2)
	}
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		logger.Error("rome-hostd requires Linux root")
		os.Exit(1)
	}
	syscall.Umask(0077)
	config, err := hosthelper.LoadConfig(*configPath)
	if err != nil {
		logger.Error("invalid host config", "error", err)
		os.Exit(1)
	}
	server, err := hosthelper.New(config, version, logger)
	if err != nil {
		logger.Error("cannot start host helper", "error", err)
		os.Exit(1)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	logger.Info("rome-hostd started", "version", version, "hostId", config.HostID, "enabled", config.Enabled)
	exitCode := 0
	select {
	case <-signals:
	case err = <-done:
		if err != nil {
			logger.Error("host helper listener stopped", "error", err)
			exitCode = 1
		}
	}
	server.Close()
	signal.Stop(signals)
	os.Exit(exitCode)
}

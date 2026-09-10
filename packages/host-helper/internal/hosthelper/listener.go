package hosthelper

import (
	"net"
	"sync"
)

type limitedListener struct {
	net.Listener
	slots chan struct{}
}

type limitedConn struct {
	net.Conn
	once  sync.Once
	slots chan struct{}
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: conn, slots: l.slots}, nil
		default:
			conn.Close()
		}
	}
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	// HTTP may close a connection on several concurrent shutdown paths.
	c.once.Do(func() { <-c.slots })
	return err
}

import net from 'node:net';

/**
 * Reserves a free TCP port for a test server.
 *
 * The IT test files used to draw their port from a random range. The four
 * ranges overlapped, so two test files could pick the same port; the second
 * bridge then failed to bind and its test file reported "server did not boot".
 * The overlap was rare but reproducible.
 *
 * Asking the operating system for a free port removes the overlap entirely:
 * the port is bound by this process, handed to the caller and released, so
 * two test files that run at the same time cannot pick the same one.
 *
 * @param {number} [fallbackPort] used when the OS cannot be asked
 * @returns {Promise<number>}
 */
export async function freePort(fallbackPort = 0) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(fallbackPort));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : fallbackPort;
      server.close(() => resolve(port));
    });
  });
}

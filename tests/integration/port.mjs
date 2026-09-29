import { createServer } from 'node:net';
import { once } from 'node:events';

// Ask the OS for a free port instead of assuming a shared developer port is free.
export async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

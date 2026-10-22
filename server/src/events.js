// Server-Sent Events hub. Every connected dashboard receives every event;
// payloads are small and the UI filters what it needs.

const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function publish(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// keep proxies from closing idle connections
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

export const clientCount = () => clients.size;

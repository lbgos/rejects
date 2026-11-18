// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - A raw TCP proxy outside the Effect runtime.
/**
 * CDP's Fetch domain never sees WebRTC, DNS prefetch, preconnect, WebSocket handshakes or WebTransport, so Chromium runs with `--proxy-server` pointing here.
 * It resolves names itself and serves global unicast addresses only.
 */
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

export interface EgressTarget {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
}

export interface EgressPolicy {
  readonly allows: (target: EgressTarget) => boolean;
  /** A name that resolves to a private address is always refused, so a pinned host cannot point its DNS at loopback or the LAN. Unset in production. */
  readonly permitPrivate?: ((host: string, port: number) => boolean) | undefined;
}

export const egressFlags = (port: number) => [
  `--proxy-server=http://127.0.0.1:${port}`,
  // Loopback and link-local destinations bypass a proxy by default.
  "--proxy-bypass-list=<-loopback>",
  // The proxy resolves every name; Chromium resolves nothing, so no query leaves it.
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
  // The switch is spelled `force-` in older Chromium builds and without it in current ones.
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--dns-prefetch-disable",
  "--disable-quic",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-pings",
];

const ipv4Private = (ip: string) => {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
};

const ipv6Groups = (ip: string): ReadonlyArray<number> | undefined => {
  let text = (ip.split("%")[0] ?? "").toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined && dotted[2] !== undefined && NodeNet.isIPv4(dotted[2])) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[2].split(".").map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
    ? groups.map((group) => Number.parseInt(group, 16))
    : undefined;
};

const embeddedIPv4 = (high: number, low: number) =>
  `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

export const isPrivateAddress = (ip: string): boolean => {
  if (NodeNet.isIPv4(ip)) return ipv4Private(ip);
  const groups = ipv6Groups(ip);
  if (groups === undefined) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0;
  if (zeros && e === 0 && (f === 0xffff || f === 0)) return ipv4Private(embeddedIPv4(g, h));
  if (zeros && e === 0xffff && f === 0) return ipv4Private(embeddedIPv4(g, h));
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return ipv4Private(embeddedIPv4(g, h));
  if (a === 0x2002) return ipv4Private(embeddedIPv4(b, c));
  if ((a & 0xe000) !== 0x2000) return true;
  return (a === 0x2001 && (b < 0x200 || b === 0xdb8)) || (a === 0x3fff && b < 0x1000);
};

const unbracket = (host: string) => host.replace(/^\[|\]$/g, "");

const resolveTarget = async (policy: EgressPolicy, target: EgressTarget) => {
  if (!policy.allows(target)) return undefined;
  const literal = NodeNet.isIP(target.host) !== 0;
  const addresses = literal
    ? [target.host]
    : (await NodeDnsPromises.lookup(target.host, { all: true })).map((entry) => entry.address);
  const permitted = literal && policy.permitPrivate?.(target.host, target.port) === true;
  return addresses.find((address) => permitted || !isPrivateAddress(address));
};

const refuse = (socket: NodeNet.Socket, status: string) =>
  socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);

export interface EgressProxy {
  readonly port: number;
  /** Ends every open tunnel and request but keeps listening: a connection checked under an old pin. */
  readonly closeConnections: () => void;
  readonly close: () => void;
}

export const EGRESS_PORTS = [38000, 38099] as const;

export const startEgressProxy = (policy: EgressPolicy, ports?: readonly [number, number]) =>
  new Promise<EgressProxy>((resolve, reject) => {
    const tunnels = new Set<NodeNet.Socket>();
    // Bumped when connections are cut: a request still resolving its name was checked under the old pin.
    let generation = 0;
    const server = NodeHttp.createServer((request, response) => {
      // Plain http:// requests arrive with an absolute URL; https and ws use CONNECT.
      let url: URL;
      try {
        url = new URL(request.url ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (url.protocol !== "http:") {
        response.writeHead(400).end();
        return;
      }
      const target = {
        scheme: "http",
        host: unbracket(url.hostname),
        port: Number(url.port || 80),
      } as const;
      const fail = (status: number) => {
        if (!response.headersSent) response.writeHead(status);
        response.end();
      };
      const born = generation;
      resolveTarget(policy, target).then(
        (address) => {
          if (address === undefined) return fail(403);
          if (born !== generation) return fail(503);
          const {
            "proxy-connection": _drop,
            "proxy-authorization": _auth,
            ...headers
          } = request.headers;
          const upstream = NodeHttp.request(
            {
              host: address,
              port: target.port,
              method: request.method,
              path: `${url.pathname}${url.search}`,
              headers,
            },
            (reply) => {
              response.writeHead(reply.statusCode ?? 502, reply.headers);
              reply.pipe(response);
            },
          );
          // The upstream socket is cut with the tunnels when the pin changes or the sheet closes.
          upstream.on("socket", (socket) => {
            tunnels.add(socket);
            socket.on("close", () => tunnels.delete(socket));
          });
          upstream.on("error", () => fail(502));
          response.on("close", () => upstream.destroy());
          request.on("aborted", () => upstream.destroy());
          request.pipe(upstream);
        },
        () => fail(502),
      );
    });
    server.on("connect", (request, client: NodeNet.Socket, head) => {
      tunnels.add(client);
      client.on("close", () => tunnels.delete(client));
      client.on("error", () => client.destroy());
      const separator = (request.url ?? "").lastIndexOf(":");
      const host = unbracket((request.url ?? "").slice(0, separator));
      const port = Number((request.url ?? "").slice(separator + 1));
      if (separator < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
        return refuse(client, "400 Bad Request");
      const target = { scheme: port === 80 ? "http" : "https", host, port } as const;
      const born = generation;
      resolveTarget(policy, target).then(
        (address) => {
          if (address === undefined) return refuse(client, "403 Forbidden");
          if (born !== generation) return refuse(client, "503 Service Unavailable");
          const upstream = NodeNet.connect({ host: address, port }, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          tunnels.add(upstream);
          upstream.on("close", () => {
            tunnels.delete(upstream);
            client.destroy();
          });
          upstream.on("error", () => upstream.destroy());
          client.on("close", () => upstream.destroy());
        },
        () => refuse(client, "502 Bad Gateway"),
      );
    });
    const [low, high] = ports ?? [0, 0];
    let tried = 0;
    const listen = (port: number) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (ports !== undefined && error.code === "EADDRINUSE" && ++tried <= high - low)
          return listen(low + ((port - low + 1) % (high - low + 1)));
        reject(
          ports !== undefined && error.code === "EADDRINUSE"
            ? new Error(`No free port in ${low}-${high} for an egress proxy.`)
            : error,
        );
      });
      server.listen(port, "127.0.0.1");
    };
    server.on("listening", () => {
      server.removeAllListeners("error");
      server.on("error", () => undefined);
      const { port } = server.address() as NodeNet.AddressInfo;
      const closeConnections = () => {
        generation++;
        for (const socket of tunnels) socket.destroy();
        server.closeAllConnections();
      };
      resolve({
        port,
        closeConnections,
        close: () => {
          closeConnections();
          server.close();
        },
      });
    });
    listen(low);
  });

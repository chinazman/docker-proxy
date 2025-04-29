// server.js
import http from 'http';
import { URL } from 'url'; // Node.js URL API

// 从环境变量获取配置，提供默认值
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || 'your-custom-domain.com'; // 需要用户设置
const MODE = process.env.MODE || 'production'; // 'production' or 'debug'
const TARGET_UPSTREAM = process.env.TARGET_UPSTREAM || 'http://localhost:5000'; // 仅在 debug 模式下使用
const PORT = process.env.PORT || 3000; // 监听端口

const dockerHub = "https://registry-1.docker.io";

const routes = {
  // production
  ["docker." + CUSTOM_DOMAIN]: dockerHub,
  ["quay." + CUSTOM_DOMAIN]: "https://quay.io",
  ["gcr." + CUSTOM_DOMAIN]: "https://gcr.io",
  ["k8s-gcr." + CUSTOM_DOMAIN]: "https://k8s.gcr.io",
  ["k8s." + CUSTOM_DOMAIN]: "https://registry.k8s.io",
  ["ghcr." + CUSTOM_DOMAIN]: "https://ghcr.io",
  ["cloudsmith." + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io",
  ["ecr." + CUSTOM_DOMAIN]: "https://public.ecr.aws",

  // staging (如果需要，可以添加)
  // ["docker-staging." + CUSTOM_DOMAIN]: dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE === "debug") {
    try {
        new URL(TARGET_UPSTREAM);
        return TARGET_UPSTREAM;
    } catch (e) {
        console.error(`Invalid TARGET_UPSTREAM URL in debug mode: ${TARGET_UPSTREAM}`);
        return "";
    }
  }
  return "";
}

async function handleRequest(req, res) {
  const requestUrl = `http://${req.headers.host}${req.url}`;
  let url;
  try {
      url = new URL(requestUrl);
  } catch (e) {
      console.error(`Invalid request URL: ${requestUrl}`, e);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "Bad Request", details: "Invalid URL format" }));
      return;
  }

  const upstream = routeByHosts(url.hostname);

  if (upstream === "") {
    console.log(`No route found for host: ${url.hostname}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: "Route not found", available_routes: Object.keys(routes) }));
    return;
  }

  console.log(`Routing ${url.hostname}${url.pathname} to ${upstream}`);

  const isDockerHub = upstream === dockerHub;
  const authorization = req.headers['authorization'];

  try {
    // --- /v2/ endpoint check ---
    if (url.pathname === "/v2/") {
      const newUrl = new URL(upstream + "/v2/");
      const headers = {};
      if (authorization) headers['Authorization'] = authorization;

      console.log(`Checking upstream /v2/ endpoint: ${newUrl}`);
      const resp = await fetch(newUrl.toString(), { method: "GET", headers: headers, redirect: "follow" });
      console.log(`Upstream /v2/ response status: ${resp.status}`);

      if (resp.status === 401) {
        console.log('Upstream requires authentication, responding with 401 Unauthorized.');
        responseUnauthorized(url, res);
        return;
      }
      await forwardResponse(resp, res);
      return;
    }

    // --- /v2/auth token request ---
    if (url.pathname === "/v2/auth") {
      const checkUrl = new URL(upstream + "/v2/");
      console.log(`Checking upstream auth requirement at: ${checkUrl}`);
      const checkResp = await fetch(checkUrl.toString(), { method: "GET", redirect: "follow" });
      console.log(`Upstream auth check response status: ${checkResp.status}`);

      if (checkResp.status !== 401) {
        console.log('Upstream does not require auth (status != 401), forwarding response.');
        await forwardResponse(checkResp, res);
        return;
      }

      const authenticateStr = checkResp.headers.get("www-authenticate");
      if (!authenticateStr) {
        console.log('Upstream returned 401 but no WWW-Authenticate header, forwarding response.');
        await forwardResponse(checkResp, res);
        return;
      }
      console.log(`Received WWW-Authenticate: ${authenticateStr}`);

      const wwwAuthenticate = parseAuthenticate(authenticateStr);
      if (!wwwAuthenticate) {
          console.error('Failed to parse WWW-Authenticate header.');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Internal Server Error", details: "Failed to parse WWW-Authenticate header from upstream" }));
          return;
      }

      let scope = url.searchParams.get("scope");
      console.log(`Original scope: ${scope}`);
      if (scope && isDockerHub) {
        let scopeParts = scope.split(":");
        if (scopeParts.length === 3 && !scopeParts[1].includes("/")) {
          scopeParts[1] = "library/" + scopeParts[1];
          scope = scopeParts.join(":");
          console.log(`Modified DockerHub scope: ${scope}`);
        }
      }

      console.log(`Fetching token from ${wwwAuthenticate.realm} with service=${wwwAuthenticate.service}, scope=${scope}`);
      const tokenResp = await fetchToken(wwwAuthenticate, scope, authorization);
      console.log(`Token fetch response status: ${tokenResp.status}`);
      await forwardResponse(tokenResp, res);
      return;
    }

    // --- DockerHub library image redirect ---
    if (isDockerHub) {
      const pathParts = url.pathname.split("/");
      // Matches /v2/<image>/<type>/<tag_or_digest> e.g. /v2/busybox/manifests/latest
      if (pathParts.length === 5 && pathParts[1] === 'v2' && !pathParts[2].includes('/') && !pathParts[2].includes('.')) {
        const originalPath = url.pathname;
        pathParts.splice(2, 0, "library");
        const redirectPath = pathParts.join("/");
        const redirectUrl = new URL(url);
        redirectUrl.pathname = redirectPath;
        console.log(`Redirecting DockerHub library image: ${originalPath} -> ${redirectPath}`);
        res.writeHead(301, { 'Location': redirectUrl.toString() });
        res.end();
        return;
      }
    }

    // --- Forward general requests ---
    const forwardUrl = new URL(upstream + url.pathname + url.search);
    const forwardHeaders = { ...req.headers };
    forwardHeaders['host'] = new URL(upstream).host;
    delete forwardHeaders['connection'];
    // Ensure content-length is correctly set if present, or removed if chunked encoding is used
    if (req.headers['transfer-encoding'] === 'chunked') {
        delete forwardHeaders['content-length'];
    } else if (req.headers['content-length']) {
        forwardHeaders['content-length'] = req.headers['content-length'];
    }


    console.log(`Forwarding request: ${req.method} ${forwardUrl}`);
    const newReqOptions = {
      method: req.method,
      headers: forwardHeaders,
      redirect: isDockerHub ? "manual" : "follow",
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
      duplex: 'half' // Required for request body streaming
    };

    const resp = await fetch(forwardUrl.toString(), newReqOptions);
    console.log(`Forwarded request response status: ${resp.status}`);

    if (resp.status === 401) {
      console.log('Forwarded request returned 401, responding with Unauthorized.');
      responseUnauthorized(url, res);
      return;
    }

    // --- Handle DockerHub blob redirect manually ---
    if (isDockerHub && resp.status === 307) {
      const location = resp.headers.get("location");
      if (location) {
        console.log(`Handling DockerHub 307 redirect to: ${location}`);
        const redirectResp = await fetch(location, { redirect: "follow" });
        console.log(`Redirected blob fetch status: ${redirectResp.status}`);
        await forwardResponse(redirectResp, res);
      } else {
        console.warn('Received 307 from DockerHub but no Location header.');
        await forwardResponse(resp, res); // Forward original 307
      }
      return;
    }

    // --- Forward the response ---
    await forwardResponse(resp, res);

  } catch (error) {
    console.error(`Error handling request for ${requestUrl}:`, error);
    // Avoid sending detailed internal errors to the client unless in debug mode
    const errorDetails = MODE === 'debug' ? error.message : "An internal error occurred.";
    if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    // Ensure we don't try to write to an already ended response
    if (!res.writableEnded) {
        res.end(JSON.stringify({ error: "Internal Server Error", details: errorDetails }));
    }
  }
}

async function forwardResponse(fetchResponse, nodeResponse) {
  nodeResponse.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, name) => {
    // Filter headers Node.js http module handles automatically or that cause issues
    const lowerCaseName = name.toLowerCase();
    if (lowerCaseName !== 'content-encoding' &&
        lowerCaseName !== 'transfer-encoding' &&
        lowerCaseName !== 'connection') {
      try {
        nodeResponse.setHeader(name, value);
      } catch (e) {
        console.warn(`Failed to set header ${name}: ${value}`, e.message);
      }
    }
  });

  // Add a check before streaming body
  if (fetchResponse.body) {
    try {
      for await (const chunk of fetchResponse.body) {
        if (!nodeResponse.write(chunk)) {
          // Handle backpressure
          await new Promise(resolve => nodeResponse.once('drain', resolve));
        }
      }
    } catch (streamError) {
        console.error('Error streaming response body:', streamError);
        // Attempt to end the response gracefully if possible
        if (!nodeResponse.writableEnded) {
            nodeResponse.end();
        }
        // Rethrow or handle as appropriate, maybe close connection
        throw streamError; // Propagate error to the main handler's catch block
    }
  }
  if (!nodeResponse.writableEnded) {
    nodeResponse.end();
  }
}

function parseAuthenticate(authenticateStr) {
  const result = {};
  // Regex to capture key (realm or service) and its value directly
  const re = /\b(realm|service)="([^"]*)"/g;
  let match;

  while ((match = re.exec(authenticateStr)) !== null) {
    // match[1] is the key (e.g., 'realm' or 'service')
    // match[2] is the value (e.g., 'https://auth.docker.io/token')
    if (match[1] && match[2]) {
      result[match[1]] = match[2];
    }
  }

  // Check if both essential parts were found
  if (!result.realm || !result.service) {
    console.error(`Failed to parse realm or service from Www-Authenticate: ${authenticateStr}. Parsed: ${JSON.stringify(result)}`);
    return null; // Indicate failure
  }
  return result;
}


async function fetchToken(wwwAuthenticate, scope, authorization) {
  if (!wwwAuthenticate || !wwwAuthenticate.realm) {
      console.error("Cannot fetch token: Missing realm in WWW-Authenticate data.");
      throw new Error("Invalid WWW-Authenticate data provided for token fetch.");
  }
  try {
    const url = new URL(wwwAuthenticate.realm);
    if (wwwAuthenticate.service) {
      url.searchParams.set("service", wwwAuthenticate.service);
    }
    if (scope) {
      url.searchParams.set("scope", scope);
    }
    const headers = {};
    if (authorization) {
      headers['Authorization'] = authorization;
    }
    console.log(`Fetching token from: ${url.toString()}`);
    // Ensure fetch handles potential errors (network, DNS, etc.)
    const response = await fetch(url.toString(), { method: "GET", headers: headers });
    if (!response.ok) {
        // Log or handle non-2xx responses specifically if needed
        console.warn(`Token fetch request to ${url.toString()} returned status ${response.status}`);
    }
    return response;
  } catch (e) {
      console.error(`Error constructing URL or fetching token from realm ${wwwAuthenticate.realm}:`, e);
      // Wrap the error for better context
      throw new Error(`Failed to fetch token due to: ${e.message}`);
  }
}

function responseUnauthorized(url, res) {
  const headers = {};
  // Determine host based on MODE, ensuring url is valid
  const realmHost = (MODE === "debug" && url && url.host) ? url.host : (url && url.hostname ? url.hostname : 'unknown-host');
  const protocol = MODE === "debug" ? "http" : "https";
  // Construct WWW-Authenticate header safely
  headers['WWW-Authenticate'] = `Bearer realm="${protocol}://${realmHost}/v2/auth",service="cloudflare-docker-proxy"`;
  headers['Content-Type'] = 'application/json'; // Ensure correct content type

  // Check if headers are already sent before writing head
  if (!res.headersSent) {
    res.writeHead(401, headers);
  } else {
      console.warn("Headers already sent, cannot set 401 status for unauthorized response.");
  }
  // Check if response is writable before ending
  if (!res.writableEnded) {
    res.end(JSON.stringify({ message: "UNAUTHORIZED" }));
  } else {
      console.warn("Response already ended, cannot send UNAUTHORIZED message body.");
  }
}


const server = http.createServer(async (req, res) => {
    try {
        await handleRequest(req, res);
    } catch (e) {
        // Catch any unexpected errors from handleRequest itself (e.g., during initial URL parsing)
        console.error("Critical error in request handler:", e);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.writableEnded) {
            res.end(JSON.stringify({ error: "Internal Server Error", details: "An unexpected error occurred" }));
        }
    }
});


server.listen(PORT, () => {
  console.log(`Node.js Docker Proxy server running on port ${PORT}`);
  console.log(`Mode: ${MODE}`);
  if (MODE === 'debug') {
      console.log(`Debug Target Upstream: ${TARGET_UPSTREAM}`);
  }
  console.log('Configured routes:');
  for (const host in routes) {
      console.log(`  ${host} -> ${routes[host]}`);
  }
  if (!process.env.CUSTOM_DOMAIN && MODE !== 'debug') {
      console.warn('Warning: CUSTOM_DOMAIN environment variable is not set. Routes based on it might not work as expected.');
  }
});

server.on('error', (err) => {
    console.error('Server error:', err);
    // Handle specific server errors like EADDRINUSE
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Please choose another port.`);
        process.exit(1); // Exit if the port is occupied
    }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Consider logging the stack trace: console.error(reason.stack || reason);
});

process.on('uncaughtException', (err, origin) => {
  console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`);
  console.error(err.stack);
  // It's critical to properly shut down the server or restart the process
  // For example, attempt a graceful shutdown:
  console.log('Attempting graceful shutdown due to uncaught exception...');
  server.close(() => {
      console.log('Server closed.');
      process.exit(1); // Exit after closing server
  });
  // Force exit if server closing hangs
  setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit.');
      process.exit(1);
  }, 5000); // 5 seconds timeout
});

// Handle SIGTERM for graceful shutdown (e.g., from Docker or systemd)
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0); // Exit gracefully
    });
});
const DOH_ENDPOINT = "https://dns.google/resolve";

async function resolveWithGoogleDns(name, type) {
  const response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`);
  if (!response.ok) {
    throw new Error(`DNS lookup failed for ${name} (${response.status})`);
  }

  const payload = await response.json();
  if (payload.Status !== 0 || !payload.Answer?.length) {
    throw new Error(`DNS lookup returned no records for ${name}`);
  }

  return payload.Answer;
}

function parseSrvRecords(records) {
  return records
    .filter((record) => record.type === 33)
    .map((record) => {
      const [priority, weight, port, target] = record.data.split(" ");
      return {
        priority: Number(priority),
        weight: Number(weight),
        port: Number(port),
        name: target.endsWith(".") ? target.slice(0, -1) : target,
      };
    });
}

function parseTxtRecords(records) {
  return records
    .filter((record) => record.type === 16)
    .map((record) => record.data.replace(/^"|"$/g, ""));
}

async function resolveMongoUri(uri) {
  if (!uri?.startsWith("mongodb+srv://")) {
    return uri;
  }

  const match = uri.match(/^mongodb\+srv:\/\/([^@]+)@([^/?]+)(.*)$/);
  if (!match) {
    return uri;
  }

  const [, credentials, hostname, pathAndQuery] = match;
  const srvHost = `_mongodb._tcp.${hostname}`;

  const [srvAnswer, txtAnswer] = await Promise.all([
    resolveWithGoogleDns(srvHost, "SRV"),
    resolveWithGoogleDns(hostname, "TXT").catch(() => []),
  ]);

  const srvRecords = parseSrvRecords(srvAnswer);
  if (!srvRecords.length) {
    throw new Error(`No SRV records found for ${srvHost}`);
  }

  const hosts = srvRecords.map((record) => `${record.name}:${record.port}`).join(",");
  const txtOptions = parseTxtRecords(txtAnswer).join("&");
  const queryIndex = pathAndQuery.indexOf("?");
  const dbPath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const existingQuery = queryIndex === -1 ? "" : pathAndQuery.slice(queryIndex + 1);

  const params = new URLSearchParams(txtOptions);
  for (const [key, value] of new URLSearchParams(existingQuery)) {
    params.set(key, value);
  }

  if (!params.has("ssl")) {
    params.set("ssl", "true");
  }

  return `mongodb://${credentials}@${hosts}${dbPath}?${params.toString()}`;
}

module.exports = { resolveMongoUri };

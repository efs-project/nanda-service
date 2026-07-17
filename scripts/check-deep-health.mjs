const healthUrl = process.env.HEALTH_URL ?? "https://efs-scribe-production.up.railway.app/health/deep";
const expectedMode = process.env.EXPECTED_MODE ?? "sepolia";
const timeoutMs = Number.parseInt(process.env.HEALTH_TIMEOUT_MS ?? "15000", 10);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);

try {
  const response = await fetch(healthUrl, {
    signal: controller.signal,
    headers: {
      accept: "application/json",
      "user-agent": "efs-scribe-health-check/1.0"
    }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`Health check returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }

  const failures = [];
  if (!response.ok) {
    failures.push(`HTTP ${response.status}`);
  }
  if (body?.ok !== true) {
    failures.push(`body.ok is ${JSON.stringify(body?.ok)}`);
  }
  if (body?.mode !== expectedMode) {
    failures.push(`mode is ${JSON.stringify(body?.mode)}, expected ${JSON.stringify(expectedMode)}`);
  }

  const failedChecks = Array.isArray(body?.checks)
    ? body.checks.filter((check) => check?.ok !== true)
    : [];
  if (failedChecks.length > 0) {
    failures.push(`failed checks: ${failedChecks.map((check) => check.name ?? "<unnamed>").join(", ")}`);
  }

  if (failures.length > 0) {
    console.error("EFS Scribe deep health is degraded.");
    console.error(`URL: ${healthUrl}`);
    console.error(`Reasons: ${failures.join("; ")}`);
    console.error(JSON.stringify({
      status: response.status,
      mode: body?.mode,
      ok: body?.ok,
      failed_checks: failedChecks,
      sepolia: body?.sepolia
    }, null, 2));
    process.exit(1);
  }

  const sponsor = body?.sepolia?.sponsor;
  console.log("EFS Scribe deep health OK.");
  console.log(JSON.stringify({
    status: response.status,
    mode: body.mode,
    checked_at: body.checked_at,
    sponsor_address: sponsor?.address,
    sponsor_balance_eth: sponsor?.balance_eth,
    sponsor_low_balance: sponsor?.low_balance
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Health check request failed: ${message}`);
} finally {
  clearTimeout(timeout);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

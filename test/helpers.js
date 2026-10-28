// Utilidades compartidas por los tests.

export function fakeLog() {
  const lines = [];
  const add = (level) => (msg) => lines.push({ level, msg });
  return {
    lines,
    error: add('error'),
    warn: add('warn'),
    info: add('info'),
    debug: add('debug'),
    has: (level, fragment) => lines.some((l) => l.level === level && l.msg.includes(fragment)),
  };
}

export const KEY = (host) =>
  JSON.stringify({
    oauth: {
      clientid: 'sb-client!b1|it!b2',
      clientsecret: 'super-secret-value',
      url: `https://${host}`,
      tokenurl: `https://auth.${host}/oauth/token`,
    },
  });

export function validEnv(overrides = {}) {
  return {
    CPI_API_SERVICE_KEY: KEY('tenant.example.com'),
    ALERT_SERVICE_KEY: KEY('tenant-rt.example.com'),
    ALERT_ENDPOINT_PATH: '/http/pipeline/alert',
    CLIENT_NAME: 'VetClinic',
    ENVIRONMENT: 'prod',
    MONITORED_QUEUES: 'Q1, Q2',
    MONITORING_FREQ_IN_MINUTES: '5',
    MONITORING_WAIT_IN_SECONDS: '60',
    ...overrides,
  };
}

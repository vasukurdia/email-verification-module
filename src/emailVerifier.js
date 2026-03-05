'use strict';

const dns = require('dns').promises;
const net = require('net');

const RESULT_CODES = { valid: 1, unknown: 3, invalid: 6 };

const COMMON_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'aol.com', 'protonmail.com', 'live.com', 'msn.com', 'me.com',
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function getDidYouMean(email) {
  if (!email || typeof email !== 'string') return null;
  const atIdx = email.lastIndexOf('@');
  if (atIdx === -1) return null;
  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1).toLowerCase();
  if (COMMON_DOMAINS.includes(domain)) return null;
  let bestDomain = null, bestDist = Infinity;
  for (const candidate of COMMON_DOMAINS) {
    const dist = levenshtein(domain, candidate);
    if (dist < bestDist) { bestDist = dist; bestDomain = candidate; }
  }
  return (bestDist <= 2 && bestDomain !== domain) ? (localPart + '@' + bestDomain) : null;
}

function validateSyntax(email) {
  if (!email || typeof email !== 'string')
    return { valid: false, reason: 'Email must be a non-empty string' };
  const t = email.trim();
  if (t.length === 0)  return { valid: false, reason: 'Email is empty' };
  if (t.length > 254)  return { valid: false, reason: 'Email exceeds maximum length of 254 characters' };
  const atCount = (t.match(/@/g) || []).length;
  if (atCount === 0) return { valid: false, reason: 'Missing @ symbol' };
  if (atCount > 1)   return { valid: false, reason: 'Multiple @ symbols found' };
  const parts = t.split('@');
  const local = parts[0], domain = parts[1];
  if (!local || local.length === 0)   return { valid: false, reason: 'Missing local part before @' };
  if (local.length > 64)              return { valid: false, reason: 'Local part exceeds 64 characters' };
  if (!domain || domain.length === 0) return { valid: false, reason: 'Missing domain after @' };
  if (/\.\./.test(t))                 return { valid: false, reason: 'Consecutive dots are not allowed' };
  if (local.startsWith('.') || local.endsWith('.'))
    return { valid: false, reason: 'Local part cannot start or end with a dot' };
  const re = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  if (!re.test(t)) return { valid: false, reason: 'Invalid email format' };
  return { valid: true };
}

async function getMxRecords(domain) {
  const records = await dns.resolveMx(domain);
  records.sort((a, b) => a.priority - b.priority);
  return records.map(r => r.exchange);
}

function smtpProbe(mxHost, email, timeoutMs) {
  if (!timeoutMs) timeoutMs = 10000;
  return new Promise(function(resolve) {
    const socket = net.createConnection({ host: mxHost, port: 25 });
    let buffer = '', step = 0;
    function done(result, subresult) { socket.destroy(); resolve({ result, subresult }); }
    socket.setTimeout(timeoutMs);
    socket.on('timeout', function() { done('unknown', 'connection_timeout'); });
    socket.on('error',   function() { done('unknown', 'connection_error'); });
    socket.on('data', function(chunk) {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const line = buffer.trim();
      buffer = '';
      if (step === 0) {
        if (!line.startsWith('2')) return done('unknown', 'connection_error');
        step = 1; socket.write('EHLO email-verifier.local\r\n');
      } else if (step === 1) {
        const lines = line.split('\n');
        if (!lines.some(l => /^250 /.test(l))) return;
        step = 2; socket.write('MAIL FROM:<verify@email-verifier.local>\r\n');
      } else if (step === 2) {
        if (!line.startsWith('2')) return done('unknown', 'smtp_error');
        step = 3; socket.write('RCPT TO:<' + email + '>\r\n');
      } else if (step === 3) {
        const code = parseInt(line.slice(0, 3), 10);
        if (code >= 200 && code < 300)                         done('valid',   'mailbox_exists');
        else if (code === 550 || code === 551 || code === 553) done('invalid', 'mailbox_does_not_exist');
        else if (code === 450 || code === 451 || code === 452) done('unknown', 'greylisted');
        else if (code === 421)                                 done('unknown', 'smtp_unavailable');
        else                                                    done('unknown', 'smtp_error');
      }
    });
  });
}

async function verifyEmail(email) {
  const startTime = Date.now();
  const base = {
    email: email, result: 'unknown', resultcode: RESULT_CODES.unknown,
    subresult: null, domain: null, mxRecords: [], didyoumean: null,
    executiontime: 0, error: null, timestamp: new Date().toISOString(),
  };
  function elapsed() { return parseFloat(((Date.now() - startTime) / 1000).toFixed(2)); }

  const syntaxCheck = validateSyntax(email);
  if (!syntaxCheck.valid) {
    const suggestion = getDidYouMean(email);
    return Object.assign({}, base, {
      result: 'invalid', resultcode: RESULT_CODES.invalid,
      subresult: suggestion ? 'typo_detected' : 'invalid_syntax',
      didyoumean: suggestion, error: syntaxCheck.reason, executiontime: elapsed()
    });
  }

  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  base.domain = domain;
  base.didyoumean = getDidYouMean(email);

  if (base.didyoumean) {
    return Object.assign({}, base, {
      result: 'invalid', resultcode: RESULT_CODES.invalid,
      subresult: 'typo_detected', executiontime: elapsed()
    });
  }

  let mxRecords;
  try {
    mxRecords = await getMxRecords(domain);
  } catch(e) {
    return Object.assign({}, base, {
      result: 'invalid', resultcode: RESULT_CODES.invalid,
      subresult: 'no_mx_records', error: 'No MX records found for domain: ' + domain,
      executiontime: elapsed()
    });
  }
  base.mxRecords = mxRecords;

  let smtpResult;
  try {
    smtpResult = await smtpProbe(mxRecords[0], email);
  } catch(e) {
    smtpResult = { result: 'unknown', subresult: 'connection_error' };
  }

  return Object.assign({}, base, {
    result: smtpResult.result,
    resultcode: RESULT_CODES[smtpResult.result] !== undefined ? RESULT_CODES[smtpResult.result] : RESULT_CODES.unknown,
    subresult: smtpResult.subresult, executiontime: elapsed()
  });
}

module.exports = { verifyEmail, getDidYouMean, validateSyntax, levenshtein, getMxRecords, smtpProbe, RESULT_CODES, COMMON_DOMAINS };
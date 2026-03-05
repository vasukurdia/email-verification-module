'use strict';

const EventEmitter = require('events');

jest.mock('dns', () => ({
  promises: {
    resolveMx: jest.fn(),
  },
}));

const mockSocket = new EventEmitter();
mockSocket.write   = jest.fn();
mockSocket.destroy = jest.fn();
mockSocket.setTimeout = jest.fn();

jest.mock('net', () => ({
  createConnection: jest.fn(() => mockSocket),
}));

const dns = require('dns').promises;
const net = require('net');
const { verifyEmail, getDidYouMean, validateSyntax, levenshtein, RESULT_CODES } = require('../src/emailVerifier');

function emulateSMTP(rcptCode) {
  setTimeout(() => mockSocket.emit('data', Buffer.from('220 smtp.example.com ESMTP\r\n')), 10);
  setTimeout(() => mockSocket.emit('data', Buffer.from('250-smtp.example.com\r\n250 OK\r\n')), 20);
  setTimeout(() => mockSocket.emit('data', Buffer.from('250 OK\r\n')), 30);
  setTimeout(() => mockSocket.emit('data', Buffer.from(rcptCode + ' result\r\n')), 40);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSocket.removeAllListeners();
  mockSocket.write.mockImplementation(() => {});
  mockSocket.destroy.mockImplementation(() => {});
  mockSocket.setTimeout.mockImplementation(() => {});
  dns.resolveMx.mockResolvedValue([{ exchange: 'mx1.example.com', priority: 10 }]);
  net.createConnection.mockReturnValue(mockSocket);
});

describe('levenshtein()', () => {
  test('identical strings => distance 0', () => {
    expect(levenshtein('gmail.com', 'gmail.com')).toBe(0);
  });
  test('empty string vs "abc" => distance 3', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });
  test('both empty strings => distance 0', () => {
    expect(levenshtein('', '')).toBe(0);
  });
  test('gmial.com vs gmail.com => distance <= 2', () => {
    expect(levenshtein('gmial.com', 'gmail.com')).toBeLessThanOrEqual(2);
  });
});


describe('validateSyntax()', () => {
  test('valid standard email passes', () => {
    expect(validateSyntax('user@example.com').valid).toBe(true);
  });
  test('valid email with subdomain passes', () => {
    expect(validateSyntax('user@mail.example.co.uk').valid).toBe(true);
  });
  test('valid email with plus alias passes', () => {
    expect(validateSyntax('user+tag@example.com').valid).toBe(true);
  });


  test('empty string is invalid', () => {
    expect(validateSyntax('').valid).toBe(false);
  });
  test('null is invalid', () => {
    expect(validateSyntax(null).valid).toBe(false);
  });
  test('undefined is invalid', () => {
    expect(validateSyntax(undefined).valid).toBe(false);
  });
  test('missing @ symbol is invalid', () => {
    expect(validateSyntax('userexample.com').valid).toBe(false);
  });
  test('multiple @ symbols rejected', () => {
    const r = validateSyntax('user@@example.com');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/multiple/i);
  });
  test('consecutive dots are rejected', () => {
    expect(validateSyntax('user..name@example.com').valid).toBe(false);
  });
  test('local part starting with dot is rejected', () => {
    expect(validateSyntax('.user@example.com').valid).toBe(false);
  });
  test('local part ending with dot is rejected', () => {
    expect(validateSyntax('user.@example.com').valid).toBe(false);
  });
  test('very long email (>254 chars) is rejected', () => {
    const long = 'a'.repeat(200) + '@' + 'b'.repeat(50) + '.com';
    expect(validateSyntax(long).valid).toBe(false);
  });
  test('missing domain part is invalid', () => {
    expect(validateSyntax('user@').valid).toBe(false);
  });
  test('missing local part is invalid', () => {
    expect(validateSyntax('@example.com').valid).toBe(false);
  });
});


describe('getDidYouMean()', () => {
  test('gmial.com -> gmail.com', () => {
    expect(getDidYouMean('user@gmial.com')).toBe('user@gmail.com');
  });
  test('yahooo.com -> yahoo.com', () => {
    expect(getDidYouMean('user@yahooo.com')).toBe('user@yahoo.com');
  });
  test('hotmial.com -> hotmail.com', () => {
    expect(getDidYouMean('user@hotmial.com')).toBe('user@hotmail.com');
  });
  test('outlok.com -> outlook.com', () => {
    expect(getDidYouMean('user@outlok.com')).toBe('user@outlook.com');
  });
  test('completely different domain returns null', () => {
    expect(getDidYouMean('user@totally-different-domain.org')).toBeNull();
  });
  test('null input returns null', () => {
    expect(getDidYouMean(null)).toBeNull();
  });
  test('email without @ returns null', () => {
    expect(getDidYouMean('notanemail')).toBeNull();
  });
});


describe('verifyEmail() - SMTP error codes', () => {
  test('SMTP 550 => result=invalid, subresult=mailbox_does_not_exist', async () => {
    emulateSMTP(550);
    const r = await verifyEmail('user@example.com');
    expect(r.result).toBe('invalid');
    expect(r.subresult).toBe('mailbox_does_not_exist');
    expect(r.resultcode).toBe(RESULT_CODES.invalid);
  });

  test('SMTP 450 => result=unknown (greylisted)', async () => {
    emulateSMTP(450);
    const r = await verifyEmail('user@example.com');
    expect(r.result).toBe('unknown');
    expect(r.subresult).toBe('greylisted');
    expect(r.resultcode).toBe(RESULT_CODES.unknown);
  });

  test('connection timeout => result=unknown, subresult=connection_timeout', async () => {
    net.createConnection.mockImplementation(() => {
      setTimeout(() => mockSocket.emit('timeout'), 10);
      return mockSocket;
    });
    const r = await verifyEmail('user@example.com');
    expect(r.result).toBe('unknown');
    expect(r.subresult).toBe('connection_timeout');
  });

  test('SMTP 250 => result=valid, resultcode=1', async () => {
    emulateSMTP(250);
    const r = await verifyEmail('user@example.com');
    expect(r.result).toBe('valid');
    expect(r.resultcode).toBe(1);
    expect(r.subresult).toBe('mailbox_exists');
  });
});


describe('verifyEmail() - edge cases', () => {
  test('empty string handled', async () => {
    const r = await verifyEmail('');
    expect(r.result).toBe('invalid');
  });

  test('null handled', async () => {
    const r = await verifyEmail(null);
    expect(r.result).toBe('invalid');
  });

  test('undefined handled', async () => {
    const r = await verifyEmail(undefined);
    expect(r.result).toBe('invalid');
  });

  test('very long email handled', async () => {
    const long = 'a'.repeat(200) + '@' + 'b'.repeat(50) + '.com';
    const r = await verifyEmail(long);
    expect(r.result).toBe('invalid');
  });

  test('multiple @ symbols rejected', async () => {
    const r = await verifyEmail('user@@example.com');
    expect(r.result).toBe('invalid');
  });

  test('typo detected => didyoumean populated', async () => {
    const r = await verifyEmail('user@gmial.com');
    expect(r.result).toBe('invalid');
    expect(r.subresult).toBe('typo_detected');
    expect(r.didyoumean).toBe('user@gmail.com');
  });

  test('no MX records => subresult=no_mx_records', async () => {
    dns.resolveMx.mockRejectedValue(new Error('ENOTFOUND'));
    const r = await verifyEmail('user@nxdomain-xyz-99.com');
    expect(r.subresult).toBe('no_mx_records');
  });

  test('result object has all required fields', async () => {
    emulateSMTP(250);
    const r = await verifyEmail('user@example.com');
    const fields = ['email','result','resultcode','subresult','domain','mxRecords','executiontime','error','timestamp'];
    fields.forEach(f => expect(r).toHaveProperty(f));
  });

  test('executiontime is a number', async () => {
    emulateSMTP(250);
    const r = await verifyEmail('user@example.com');
    expect(typeof r.executiontime).toBe('number');
  });

  test('timestamp is a valid ISO string', async () => {
    emulateSMTP(250);
    const r = await verifyEmail('user@example.com');
    expect(new Date(r.timestamp).toISOString()).toBe(r.timestamp);
  });
});
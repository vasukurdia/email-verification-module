const express = require('express');
const { verifyEmail, getDidYouMean } = require('./src/emailVerifier');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Email Verification API',
    endpoints: {
      verify: 'GET /verify?email=user@example.com',
      didyoumean: 'GET /didyoumean?email=user@gmial.com',
    },
  });
});

// Verify email
app.get('/verify', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'email query parameter is required' });
  }

  try {
    const result = await verifyEmail(email);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// Did you mean
app.get('/didyoumean', (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'email query parameter is required' });
  }

  const suggestion = getDidYouMean(email);
  res.json({
    email,
    didyoumean: suggestion,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;

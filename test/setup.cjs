// Test-only default. Production continues to require an explicit strong secret.
process.env.SESSION_SECRET ||= 'test-only-session-secret-at-least-32-characters';

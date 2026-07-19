-- Drop existing tables if needed (for clean start)
DROP TABLE IF EXISTS reminders_log;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS session;

CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    giver_email VARCHAR(100) NOT NULL,
    receiver_email VARCHAR(100) NOT NULL,
    action VARCHAR(10) CHECK (action IN ('borrow', 'return')) NOT NULL,
    key_name VARCHAR(50) NOT NULL,
    quantity INT NOT NULL,
    planned_return TIMESTAMP,
    borrowed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    returned_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'borrowed' CHECK (status IN ('borrowed','returned','overdue'))
);

CREATE TABLE otp_codes (
    email VARCHAR(100) NOT NULL,
    code VARCHAR(6) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    used BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (email, code)
);

CREATE TABLE reminders_log (
    id SERIAL PRIMARY KEY,
    transaction_id INT REFERENCES transactions(id),
    reminder_type VARCHAR(20),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transactions_status_planned_return ON transactions(status, planned_return) WHERE status = 'borrowed';

-- Session table for express-session
CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
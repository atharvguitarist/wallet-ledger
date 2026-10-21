-- 004_reference_data.sql
-- Rows the system needs before the first request.

-- System accounts (requirement 3). They belong to no user and may go negative:
-- cash_in goes negative by exactly the total money ever topped up.
INSERT INTO accounts (kind, system_code, name) VALUES
    ('system', 'cash_in',     'Cash-in (top-ups)'),
    ('system', 'cash_out',    'Cash-out (withdrawals)'),
    ('system', 'fee_revenue', 'Fee revenue');

-- Fraud rules. Amounts in paise. Change thresholds with SQL, not code:
--   UPDATE risk_rules SET amount_threshold = 2500000 WHERE code = 'large_amount';
INSERT INTO risk_rules (code, description, action, applies_to, amount_threshold, count_threshold, window_seconds) VALUES
    ('large_amount',
     'Single transfer at or above ₹50,000',
     'hold', ARRAY['p2p', 'withdrawal'], 5000000, NULL, NULL),
    ('daily_limit',
     'Wallet would send more than ₹1,00,000 in 24 hours',
     'hold', ARRAY['p2p', 'withdrawal'], 10000000, NULL, 86400),
    ('kyc_unverified_limit',
     'Sender has not completed KYC and the transfer is above ₹5,000',
     'hold', ARRAY['p2p', 'withdrawal'], 500000, NULL, NULL),
    ('velocity',
     'More than 10 outgoing transfers from one wallet within 60 seconds',
     'flag', ARRAY['p2p', 'withdrawal'], NULL, 10, 60),
    ('new_payee_large',
     'First ever payment to this recipient and it is ₹10,000 or more',
     'flag', ARRAY['p2p'], 1000000, NULL, NULL);

INSERT INTO job_locks (job_name) VALUES ('reconciliation'), ('flag_explainer');

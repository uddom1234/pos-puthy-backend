-- Add data types support for option values (label/value in option schema)
-- This allows each option value to carry a typed value, not only strings

START TRANSACTION;

-- 1) Extend product_option_values with type-aware columns
ALTER TABLE product_option_values
  ADD COLUMN value_type ENUM('text','number','boolean','date') NOT NULL DEFAULT 'text' AFTER `value`,
  ADD COLUMN value_number DECIMAL(12,4) NULL AFTER value_type,
  ADD COLUMN value_boolean TINYINT(1) NULL AFTER value_number,
  ADD COLUMN value_date DATE NULL AFTER value_boolean;

-- 2) Migrate existing rows to text type by default
UPDATE product_option_values SET value_type = 'text' WHERE value_type IS NULL;

-- 3) Helpful index for lookups by type/value (optional)
CREATE INDEX IF NOT EXISTS idx_pov_value_type ON product_option_values (value_type);

COMMIT;



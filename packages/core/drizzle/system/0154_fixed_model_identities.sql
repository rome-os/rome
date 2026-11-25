-- Freeze legacy choices at their original provider and complete native ID.
UPDATE rome_sessions SET large_model_selection = CASE large_model_selection
  WHEN 'claude-opus' THEN 'anthropic/claude-opus-4-8[1m]'
  WHEN 'claude-opus-5-5' THEN 'anthropic/claude-opus-5-5[1m]'
  WHEN 'claude-opus-5' THEN 'anthropic/claude-opus-5[1m]'
  WHEN 'claude-opus-4-6' THEN 'anthropic/claude-opus-4-6[1m]'
  WHEN 'claude-sonnet' THEN 'anthropic/claude-sonnet-5-5'
  WHEN 'claude-haiku' THEN 'anthropic/claude-haiku-5-5'
  WHEN 'claude-fable' THEN 'anthropic/claude-fable-5-1[1m]'
  WHEN 'gpt-6-astra' THEN 'openai/gpt-6-astra'
  WHEN 'gpt-6-1-sol' THEN 'openai/gpt-6.1-sol'
  WHEN 'gpt-6-sol' THEN 'openai/gpt-6-sol'
  WHEN 'gpt-6-luna' THEN 'openai/gpt-6-luna'
  WHEN 'gpt-5-6-sol' THEN 'openai/gpt-5.6-sol'
  WHEN 'gpt-5-6-terra' THEN 'openai/gpt-5.6-terra'
  WHEN 'gpt-5-6-luna' THEN 'openai/gpt-5.6-luna'
  ELSE large_model_selection END
WHERE large_model_selection IN ('claude-opus', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-6', 'claude-sonnet', 'claude-haiku', 'claude-fable', 'gpt-6-astra', 'gpt-6-1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5-6-sol', 'gpt-5-6-terra', 'gpt-5-6-luna');
--> statement-breakpoint
UPDATE settings SET value = json_quote(CASE json_extract(value, '$')
  WHEN 'claude-opus' THEN 'anthropic/claude-opus-4-8[1m]'
  WHEN 'claude-opus-5-5' THEN 'anthropic/claude-opus-5-5[1m]'
  WHEN 'claude-opus-5' THEN 'anthropic/claude-opus-5[1m]'
  WHEN 'claude-opus-4-6' THEN 'anthropic/claude-opus-4-6[1m]'
  WHEN 'claude-sonnet' THEN 'anthropic/claude-sonnet-5-5'
  WHEN 'claude-haiku' THEN 'anthropic/claude-haiku-5-5'
  WHEN 'claude-fable' THEN 'anthropic/claude-fable-5-1[1m]'
  WHEN 'gpt-6-astra' THEN 'openai/gpt-6-astra'
  WHEN 'gpt-6-1-sol' THEN 'openai/gpt-6.1-sol'
  WHEN 'gpt-6-sol' THEN 'openai/gpt-6-sol'
  WHEN 'gpt-6-luna' THEN 'openai/gpt-6-luna'
  WHEN 'gpt-5-6-sol' THEN 'openai/gpt-5.6-sol'
  WHEN 'gpt-5-6-terra' THEN 'openai/gpt-5.6-terra'
  WHEN 'gpt-5-6-luna' THEN 'openai/gpt-5.6-luna'
  ELSE json_extract(value, '$') END)
WHERE key = 'webchatLargeModel' AND json_valid(value)
  AND json_type(value) = 'text' AND json_extract(value, '$') IN ('claude-opus', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-6', 'claude-sonnet', 'claude-haiku', 'claude-fable', 'gpt-6-astra', 'gpt-6-1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5-6-sol', 'gpt-5-6-terra', 'gpt-5-6-luna');

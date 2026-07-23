-- =========================================================
-- Remove tabelas usadas exclusivamente por telas/funções órfãs
-- (Benchmark, Executive Report, External Agent, Health, Playground,
-- Snapshots, Schema Evolution) que não fazem parte do fluxo
-- Upload -> Data Points -> Process Knowledge -> Structured Knowledge
-- -> Compare Responses.
-- CASCADE cuida da ordem de dependências de FK automaticamente.
-- =========================================================
DROP TABLE IF EXISTS public.test_evaluations CASCADE;
DROP TABLE IF EXISTS public.test_runs CASCADE;
DROP TABLE IF EXISTS public.test_batches CASCADE;
DROP TABLE IF EXISTS public.test_questions CASCADE;
DROP TABLE IF EXISTS public.external_agents CASCADE;
DROP TABLE IF EXISTS public.lab_settings CASCADE;
DROP TABLE IF EXISTS public.experiment_snapshots CASCADE;
DROP TABLE IF EXISTS public.knowledge_health_snapshots CASCADE;
DROP TABLE IF EXISTS public.suggested_data_points CASCADE;

-- llm_calls.test_run_id não tem mais tabela para referenciar; a coluna fica
-- órfã (sem FK), inofensiva, mas sem uso — removida por limpeza.
ALTER TABLE public.llm_calls DROP COLUMN IF EXISTS test_run_id;

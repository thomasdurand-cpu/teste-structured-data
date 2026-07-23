-- =========================================================
-- Escopar o catálogo de tópicos/data points e o prompt de
-- extração por projeto. Hoje topic_definitions/data_point_definitions
-- são um catálogo global (só `topics` ativa um tópico dentro de um
-- projeto) e extraction_settings é um singleton único para todo o
-- app — isso faz um projeto "vazar" tópicos/prompt para os outros.
-- =========================================================

-- ---- topic_definitions: adicionar project_id, trocar UNIQUE(slug) por UNIQUE(project_id, slug) ----
ALTER TABLE public.topic_definitions ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.topic_definitions DROP CONSTRAINT IF EXISTS topic_definitions_slug_key;
ALTER TABLE public.topic_definitions ADD CONSTRAINT topic_definitions_project_slug_key UNIQUE (project_id, slug);
CREATE INDEX IF NOT EXISTS topic_definitions_project_idx ON public.topic_definitions(project_id);

-- ---- data_point_definitions: adicionar project_id ----
ALTER TABLE public.data_point_definitions ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS data_point_definitions_project_idx ON public.data_point_definitions(project_id);

-- ---- extraction_settings: adicionar project_id (o UNIQUE(singleton) é tratado mais abaixo) ----
ALTER TABLE public.extraction_settings ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE;

-- =========================================================
-- Backfill: cada topic_definition hoje é compartilhado por N
-- projetos via `topics`. O primeiro projeto "herda" a linha
-- original; os demais ganham uma cópia independente (+ seus
-- data_point_definitions), com `topics`/`knowledge_candidates`
-- remapeados para a cópia.
-- =========================================================
DO $$
DECLARE
  td RECORD;
  proj RECORD;
  is_first BOOLEAN;
  new_td_id UUID;
  dpd RECORD;
BEGIN
  FOR td IN SELECT * FROM public.topic_definitions WHERE project_id IS NULL LOOP
    is_first := true;
    FOR proj IN
      SELECT DISTINCT t.project_id AS id
      FROM public.topics t
      WHERE t.topic_definition_id = td.id
      ORDER BY t.project_id
    LOOP
      IF is_first THEN
        UPDATE public.topic_definitions SET project_id = proj.id WHERE id = td.id;
        UPDATE public.data_point_definitions SET project_id = proj.id WHERE topic_definition_id = td.id;
        is_first := false;
      ELSE
        INSERT INTO public.topic_definitions (slug, name, description, aliases, project_id)
        VALUES (td.slug, td.name, td.description, td.aliases, proj.id)
        RETURNING id INTO new_td_id;

        FOR dpd IN SELECT * FROM public.data_point_definitions WHERE topic_definition_id = td.id LOOP
          INSERT INTO public.data_point_definitions
            (topic_definition_id, field_name, field_label, field_type, description, required, active,
             extraction_strategy, regex_pattern, keywords, negative_keywords, extraction_examples, project_id)
          VALUES
            (new_td_id, dpd.field_name, dpd.field_label, dpd.field_type, dpd.description, dpd.required, dpd.active,
             dpd.extraction_strategy, dpd.regex_pattern, dpd.keywords, dpd.negative_keywords, dpd.extraction_examples, proj.id);
        END LOOP;

        UPDATE public.topics SET topic_definition_id = new_td_id
          WHERE project_id = proj.id AND topic_definition_id = td.id;
        UPDATE public.knowledge_candidates SET topic_definition_id = new_td_id
          WHERE project_id = proj.id AND topic_definition_id = td.id;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Trocar UNIQUE(singleton) por UNIQUE(project_id) ANTES do backfill — se isso rodasse
-- depois, a nova linha por-projeto ainda herdaria singleton=true por default e bateria
-- de frente (UNIQUE) com a linha antiga, fazendo o INSERT abaixo ser descartado.
ALTER TABLE public.extraction_settings DROP CONSTRAINT IF EXISTS extraction_settings_singleton_key;
ALTER TABLE public.extraction_settings DROP COLUMN IF EXISTS singleton;
ALTER TABLE public.extraction_settings ADD CONSTRAINT extraction_settings_project_key UNIQUE (project_id);

-- =========================================================
-- Backfill de extraction_settings: cada projeto existente ganha
-- sua própria cópia do prompt/parâmetros que hoje são globais,
-- para não perder o comportamento atual ao ativar o isolamento.
-- =========================================================
DO $$
DECLARE
  old_settings RECORD;
  proj RECORD;
BEGIN
  SELECT * INTO old_settings FROM public.extraction_settings WHERE project_id IS NULL LIMIT 1;
  IF FOUND THEN
    FOR proj IN SELECT id FROM public.projects LOOP
      INSERT INTO public.extraction_settings
        (project_id, chunk_size, max_chunks, temperature, system_prompt, extraction_prompt, unified_prompt, use_llm_for_dynamic)
      VALUES
        (proj.id, old_settings.chunk_size, old_settings.max_chunks, old_settings.temperature,
         old_settings.system_prompt, old_settings.extraction_prompt, old_settings.unified_prompt, old_settings.use_llm_for_dynamic)
      ON CONFLICT (project_id) DO NOTHING;
    END LOOP;
  END IF;
  DELETE FROM public.extraction_settings WHERE project_id IS NULL;
END $$;

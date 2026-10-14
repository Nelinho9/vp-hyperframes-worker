# E01 — Worker prepare / activation / published readers

Data: 2026-10-14 (Europe/Lisbon); último gate começou às **2026-10-14T02:49:15.011Z**. Ambiente: local, worker `H:/Antigravity Projects/VisttaPro/vp-hyperframes-worker`. Branch `feat/video-e01-composition-publication`; base `c874ae2cf53a91c2d16649c381c801a50c99c8eb`. Commit local: **AUTORIZADO / PLANEADO no fecho desta revisão**, incluindo este recibo; SHA comunicado pela sessão após a operação. Deploy/remoto/provider: **NOT_EXECUTED**. Gasto: **0 créditos**.

## Implementação ligada aos consumers

- [composition-editor.js](../../composition-editor.js) reutiliza os motores patch/restructure, `deriveElements(revision)` e `buildCoherentPublication`. `prepare-patch` e `prepare-restructure` recebem `{source_html,revision,...}` e devolvem `{ok,prepared,html,elements,applied,revision,content_hash}`. Sem staging, escrita de preview/Storage ou dependência de job existente.
- [server.js](../../server.js) regista os endpoints novos, exclusivamente com autenticação service-to-service. Não existe fallback para as antigas rotas mutáveis se um worker anterior devolver 404.
- `activate-composition` recebe `{html,revision,content_hash}`. Confirma `video_composition_heads.{project_id,revision,composition}`, contrato C5 e ambos os hashes. HTML/registry usam o mesmo namespace imutável `projects/<id>/composition-revisions/<mutation UUID>/`, com `index.html` e `elements.json`. Rejeita traversal, outro projeto, registry ausente/incoerente e revisão/hash diferentes do head.
- A ativação é serializada por projeto neste processo. Staging usa uma pasta candidata isolada, sem alterar `projectJobs` ou publicar aliases. O head é relido depois de prestage; só então se grava identidade durável e troca o pointer do preview. Candidatos sem ativação não recebem marcador que os torne visíveis no boot. Replay da mesma ativação não repete staging; revisão inferior à ativada nunca a substitui.
- Preview e thumbnails confirmam o head; staging de jobs usa a fonte publicada quando há head, validando revisão/hash enviados. Não mistura HTML de job antigo com revisão nova, não usa fallback legado em falha de DB/hash e não publica os aliases de HTML/registry durante esses jobs. Render que chega com revisão/hash stale falha antes do staging/CLI.
- `published_content_hash` identifica SHA256 UTF-8 do HTML bruto C5; `composition_hash` mantém o contrato F04, SHA256 do JSON canónico `{html}`. Um render privado autenticado pode renovar URLs assinadas no HTML derivado sem substituir a fonte committed. Ambos os blobs publicados continuam validados, a revisão é a mesma, e o HTML derivado precisa coincidir com o seu hash F04. [job-contract.js](../../job-contract.js) liga o hash publicado ao `logicalInputHash` apenas quando o campo existe, preservando envelopes N-1.
- As rotas mutáveis antigas permanecem para projetos N-1 sem head, com o seu auth existente. Projetos com head recebem `COMPOSITION_PREPARE_REQUIRED` 409. Um worker sem cliente Supabase só tem capacidades N-1; ativação recusa sem autoridade publicada.

Falha pós-commit da ativação retorna `activated:false`, `preview_sync_pending:true`, `publication_changed:false`. O publisher Edge conserva o recibo DB e `persisted:true`; falha de preview não é rollback nem nova cobrança. Os corpos de erro dos novos handlers contêm códigos, não HTML, URLs assinadas ou segredos. O HTML canónico devolvido na preparação é transporte privado ao Edge autenticado, não diagnóstico a publicar.

## Validação executada

| Gate | Resultado e limite |
|---|---|
| `npm test -- --reporter=json --outputFile=evidence/e01-composition-publication/vitest.json` | **PASS: 40 ficheiros, 497 testes, 0 failed**, incluindo 17 testes E01. [Relatório](vitest.json). Última execução inclui guard de candidatos no boot e distinção raw/derived para URLs renovadas. |
| `node --check composition-editor.js` | PASS, sintaxe JS. |
| `node --check server.js` | PASS, sintaxe JS. |
| `node --check job-contract.js` | PASS, sintaxe JS. |
| `git diff --check` | PASS. |
| ESLint scoped | **NOT_CONFIGURED**: worker não tem script/config nem ESLint instalado; nenhuma dependência foi instalada. Syntax check não é apresentado como lint. |
| Supabase/PostgreSQL real | **NOT_EXECUTED** no worker: testes usam authority/storage injetados ou simulados. CAS transacional pertence ao RPC preparado na app. |
| Browser Studio / MP4 / rollout | **NOT_EXECUTED** por este worker; HTTP local não substitui browser nem prova render final. |

[composition-editor.test.ts](../../composition-editor.test.ts) cobre HTTP real local com ficheiros de preview, auth, preparação sem job e bytes intactos, canonical media source preservada, registry versionado, head/hash/path inválidos, DB indisponível, concorrência de duas ativações, head que avança durante prestage, replay, não regressão, boot identity e job que prefere source committed sem uploads de aliases. Testa também renovação de URLs assinadas, tamper do HTML derivado, hash publicado e revisão stale, e binding do hash publicado ao input hash. Fixtures sem provider; o resto da suite usa os seus mocks/servidores locais existentes.

## Ordem de rollout e limites

1. Qualificar/aplicar primeiro a migration `visttapro/supabase/migrations/20261013230000_video_composition_publication_v1.sql`, tabela/RLS, RPC e policies do namespace imutável. Nenhuma migration foi aplicada por esta subanálise.
2. Confirmar que o cliente Supabase já configurado no worker consegue ler os heads e sources. Tabela ausente/erro DB **não** significa projeto sem head.
3. Publicar o worker com os novos handlers antes de ativar os callers Edge. A ausência dos endpoints dá 404 sem side effects de preview.
4. Só depois publicar os adaptadores Edge/readers da app e executar smokes autenticados com recibos por revisão. Deploy/provider exigem a autorização de destino/budget correspondente; não foram executados aqui.

O lock de ativação é local ao processo; a autoridade compartilhada permanece PostgreSQL. Cada instância valida o head antes de servir/ativar. Assets/fonte/fontes são derivados para staging, sem reescrever o blob canónico committed. Erros de rede/media podem deixar preview pending e requerem reconciliação; não se promete sucesso universal. Projetos headed que geram novo conteúdo precisam publicá-lo antes de enviar nova revisão ao render; não podem sobrescrever os aliases como commit.

Revisão estática feita pelo próprio implementador; a sessão principal confirmou a revisão de integração (hash condicional N-1, C5 raw/derived e staging) antes de autorizar o commit local. Não houve merge, push ou alteração de produção.

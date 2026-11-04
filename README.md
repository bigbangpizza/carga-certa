# Carga Certa

Fila e horário dos pontos de recarga de veículos elétricos do condomínio. PWA + Supabase + avisos push.

## O que você precisa fazer (uma vez, uns 40 min)

### 1. Supabase
1. Crie um projeto em supabase.com (plano Free serve para o piloto).
2. SQL Editor: rode `supabase/migrations/001_schema.sql`, depois `002_realtime_cron.sql`.
   Se o `002` reclamar do `pg_cron`, ative em Database > Extensions > `pg_cron` e rode de novo.
3. Authentication > Email Templates > **Magic Link** e **Confirm signup**: troque o corpo para mostrar o código:
   `<h2>Seu código</h2><p>{{ .Token }}</p>`
4. Authentication > Providers > Email: deixe ligado. Em Authentication > URL Configuration, ponha a URL do site (passo 4).
5. Project Settings > API: copie a **Project URL** e a **anon key**.

> O envio de e-mail do plano Free tem limite baixo por hora. Para o piloto basta; para o uso real, configure um SMTP próprio (Resend, Brevo) em Authentication > SMTP.

### 2. Chaves de push (VAPID)
```
npx web-push generate-vapid-keys
```
Guarde a pública e a privada.

### 3. Função de push
Com a Supabase CLI (`npm i -g supabase`, `supabase login`, `supabase link --project-ref SEU_REF`):
```
supabase secrets set VAPID_PUBLIC=... VAPID_PRIVATE=... VAPID_SUBJECT=mailto:seu@email.com WEBHOOK_SECRET=uma-senha-longa
supabase functions deploy push --no-verify-jwt
```
Depois, em Database > Webhooks > Create: tabela `notifications`, evento **Insert**, tipo HTTP Request (POST) para
`https://SEU_REF.supabase.co/functions/v1/push`, com o header `x-webhook-secret` igual ao `WEBHOOK_SECRET`.

### 4. Site (GitHub Pages)
1. Edite `web/config.js` com URL, anon key e chave pública VAPID.
2. Crie um repositório novo (separado de qualquer outro projeto), suba tudo e ative Pages apontando para a pasta `/web`
   (ou copie o conteúdo de `web/` para a raiz do repositório e use a branch main).
3. O endereço fica algo como `https://seuusuario.github.io/carga-certa/`.

### 5. Primeiro síndico
Abra o site, entre com seu e-mail, faça o cadastro. No SQL Editor:
```sql
update profiles set role='sindico', status='approved' where id = (select id from auth.users where email='email-do-sindico@...');
```
Recarregue o app: aparece o botão **Síndico**. Em Moradores > **Importar lista**, cole a lista de placas da administração
(`PLACA - Nome - Bl 09. Apt 004`, uma por linha). Quem se cadastrar com placa da lista já vê os dados preenchidos.

Opcional, para aprovar automaticamente quem tem placa na lista: `update settings set auto_approve = true;`

### 6. Teste
- Abra o link no celular. **iPhone:** Safari > Compartilhar > Adicionar à Tela de Início, abra por lá e toque em "Ativar avisos".
- Imprima os QR Codes em Painel (síndico) e cole um em cada ponto.
- Teste com 2 celulares: iniciar carga, entrar na fila, liberar, ver o aviso chegar.

## Modelo de cobrança
Você mantém o código e a hospedagem; o condomínio paga licença de uso mensal. O Supabase e o GitHub Pages ficam em contas suas.

## Testes
- Banco: `cd tests && npm i && node db.test.mjs` (38 verificações, roda em memória).
- App: `node tests/smoke.cjs` (precisa de `jsdom`).

## Limites conhecidos
- Realtime, pg_cron e a função de push só podem ser verificados no Supabase de verdade (não rodam local).
- A barra de progresso mostra % do **tempo** de carga, não da bateria.
- Avisos por WhatsApp são manuais (botão que abre a conversa); sem API paga.

# Jarvis Server Box

Painel de status do meu servidor de bolso — um Android rodando Termux, visto numa página só:

- **Sistema** — uptime, carga, hostname
- **Bateria** — nível, carregando ou descarregando
- **Memória e disco** — RAM, uso de disco
- **Operação** — server-box ativo e rotinas automáticas configuradas
- **Cron** — horários e próxima execução de cada rotina
- **Digest** — painel opcional; só aparece quando `~/newsdigest` existe

Zero dependências: Node puro, sem `npm install`, sem internet pra fora da rede local.

> Baseado no [server-box](https://github.com/felipenalves/server-box) de Felipe Natanael, do guia
> [Como Transformar um Celular Velho em Servidor Pessoal](https://inovadigitalid.com/blog/servidor-j5-prime).
> Licença MIT — ver [LICENSE](LICENSE).

O painel identifica o modelo pelo próprio Android. A bateria é lida pelo sistema; se o aparelho não expuser essa informação, ele tenta usar o Termux:API.

## Como rodar

No aparelho (Termux):

```bash
pkg install nodejs-lts git
git clone git@github.com:Guilhermee19/jarvis-server-box.git ~/server-box
cd ~/server-box
node server.js
```

Abre no navegador:

- rede local: `http://SEU_IP:8080`
- de fora (com Tailscale): `http://100.x.y.z:8080`

### Como ler o painel

- **Sistema** mostra os recursos atuais do aparelho: memória, disco, bateria, carga e tempo ligado.
- **Operação** é o espaço para os crons. Se ainda não existir nenhum, o painel informa isso sem tratar como erro.
- **Digest** não faz parte da instalação básica. Ele só aparece depois que o módulo `~/newsdigest` existir.

Se a bateria aparecer sem leitura, instale o pacote `termux-api` no Termux e o aplicativo Termux:API correspondente. O painel tenta `termux-battery-status` como alternativa.

## CI/CD

O celular está atrás do NAT, sem porta aberta no roteador — então o GitHub não consegue empurrar nada para ele. O deploy é **pull**: o aparelho pergunta, o GitHub só valida e promove.

```
push na main
   │
   ▼
GitHub Actions (.github/workflows/ci.yml)
   ├─ node --check em todos os .js / .mjs
   └─ se passar: git push main -> production
                                     │
                                     ▼
                        celular, cron de 5 em 5 min
                        deploy.sh: fetch + compara HEAD
                                     │
                        mudou? pull + restart do server.js
```

**Branches**

- `main` — onde você trabalha. Todo push dispara o CI.
- `production` — o que o celular roda. Criada e atualizada só pelo Actions, nunca na mão.

Se o `node --check` falhar, a `production` não se move e o celular continua rodando a última versão boa.

### `deploy.sh`

Roda no Termux e faz três coisas:

1. `git fetch origin production` e compara com o `HEAD` local.
2. Mudou → `checkout -B production origin/production`, mata o `node server.js` e sobe de novo.
3. Não mudou mas o processo caiu → sobe de novo. É o watchdog.

Se a rede estiver fora, ele não derruba nada: só garante que o painel siga no ar.

Variáveis opcionais: `SERVERBOX_DIR` (padrão `~/server-box`) e `SERVERBOX_BRANCH` (padrão `production`).

### Setup no celular (uma vez)

```bash
pkg install -y cronie
sv-enable crond

mkdir -p ~/servidor
crontab ~/server-box/crontab.txt
crontab -l
```

O arquivo [`crontab.txt`](crontab.txt) já vem com a linha pronta (caminhos absolutos, porque o cron do Termux não expande `~`):

```
*/5 * * * * sh /data/data/com.termux/files/home/server-box/deploy.sh >> /data/data/com.termux/files/home/servidor/deploy.log 2>&1
```

Acompanhar:

```bash
tail -f ~/servidor/deploy.log
```

### Deploy key

O repositório é privado, então o Termux precisa de uma **deploy key** só de leitura:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_deploy -N ""
cat ~/.ssh/id_deploy.pub
```

Cole a saída em **Settings → Deploy keys → Add deploy key** do repositório, **sem** marcar _Allow write access_. Depois aponte o remote para SSH:

```bash
cd ~/server-box
git remote set-url origin git@github.com:Guilhermee19/jarvis-server-box.git
```

## Testes

```bash
npm test
```

ou

```bash
node --test test/*.test.mjs
```

## Segurança

- Acesso só pela rede local (ou Tailscale). Não abra porta no roteador.
- Headers de segurança básicos (nosniff, frame deny, referrer policy).
- A deploy key do celular é **read-only** — se o aparelho for comprometido, ninguém escreve no repositório.
- `.j5-pin`, logs e `nohup.out` ficam fora do git.

# Jarvis Server Box

Painel de status do meu servidor de bolso — um Android rodando Termux, visto numa página só:

- **Sistema** — uptime, carga, hostname
- **Bateria** — nível, carregando ou descarregando
- **Memória e disco** — RAM, uso de disco
- **Operação** — server-box ativo e rotinas automáticas configuradas
- **Cron** — horários e próxima execução de cada rotina
- **Arquivos** — cofre com pastas: envia do celular ou do computador e abre de qualquer lugar
- **Digest** — painel opcional; só aparece quando `~/newsdigest` existe

A interface é um HUD no estilo J.A.R.V.I.S. — ciano sobre azul-noite, reator que muda
de cor com o estado do host — e cabe numa tela só, sem rolagem.

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

## Arquivos

A aba **Arquivos** transforma o painel numa gaveta do aparelho: sobe arquivo
arrastando (ou tocando no chip da barra), organiza em pastas, e abre de qualquer
lugar pelo mesmo endereço do painel — atrás do mesmo PIN.

- **Pastas** — criar, entrar, voltar pelo caminho no topo, apagar (leva o conteúdo junto).
- **Prévia** — imagem, vídeo, áudio, PDF e texto abrem numa sobreposição, sem sair da página.
- **Compartilhar** — o botão *Copiar link* põe o endereço do arquivo na área de transferência.
- **Grade ou lista** — o botão à direita da barra alterna, e a escolha fica guardada.

Onde os arquivos ficam e qual o teto de tamanho:

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `SERVERBOX_FILES_DIR` | `~/server-box-files` | Pasta raiz do cofre. Fica fora do repositório de propósito: o `deploy.sh` troca o código sem encostar nos arquivos. |
| `SERVERBOX_MAX_UPLOAD` | `536870912` (512 MB) | Limite por arquivo. Acima disso o envio é recusado com 413 e nada é gravado. |

Nos bastidores o upload é o corpo cru do POST — sem multipart, sem dependência —
e vai direto para o disco em streaming, porque a RAM do aparelho é curta:

```
GET    /api/files?path=Fotos           lista a pasta (subpastas + arquivos)
POST   /api/files?path=Fotos&name=x.png  grava o corpo da requisição como x.png
POST   /api/folders?path=Fotos/2024    cria a pasta
DELETE /api/files/<caminho>            apaga arquivo ou pasta
GET    /files/<caminho>                entrega o arquivo (aceita Range, para dar seek em vídeo)
```

Arquivo enviado é conteúdo de terceiro, então sai com `Content-Security-Policy:
default-src 'none'; sandbox`; imagem, vídeo, áudio, PDF e texto abrem na aba, e o
resto — HTML e SVG inclusive — baixa em vez de rodar na origem do painel.

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

### Voltar sozinho depois de reiniciar

O app **Termux:Boot** precisa estar instalado e **aberto pelo menos uma vez**. Depois:

```bash
mkdir -p ~/.termux/boot
ln -sf ~/server-box/boot.sh ~/.termux/boot/start.sh
chmod +x ~/server-box/boot.sh
```

O symlink aponta para o [`boot.sh`](boot.sh) do repositório, então o script de boot se atualiza sozinho a cada deploy. Ele segura o wake-lock, sobe os serviços do `termux-services`, espera a rede voltar e chama o `deploy.sh` — que atualiza se houver commit novo e, em qualquer caso, garante o painel no ar.

Testar sem reiniciar:

```bash
sh ~/.termux/boot/start.sh
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

## Acesso de fora de casa (Tailscale)

Sem abrir porta no roteador e sem expor nada para a internet: o Tailscale monta uma rede privada entre os seus dispositivos.

1. Instale o app **Tailscale** no celular (Play Store) e faça login.
2. Instale nos outros dispositivos seus, com a mesma conta.
3. No celular, o aparelho ganha um IP `100.x.y.z`. O `server.js` detecta esse endereço sozinho e imprime a URL no boot.

Acesse de qualquer rede em `http://100.x.y.z:8080`.

Para um nome melhor, crie no seu DNS um registro A `api.iamgui.dev → 100.x.y.z`. O DNS é público, mas o IP só é roteável dentro da sua tailnet — quem não estiver nela não chega a lugar nenhum.

> Deixar o painel realmente público (Cloudflare Tunnel e afins) exige autenticação na borda. O PIN abaixo é o mínimo, não o suficiente para exposição na internet aberta.

## Segurança

### PIN

O painel pede um **PIN de 4 dígitos**. Ele é gerado no primeiro start e guardado em `.j5-pin` (permissão `600`, fora do git). Para ver qual é:

```bash
cat ~/server-box/.j5-pin
```

Ele também aparece no log do boot:

```bash
tail -n 20 ~/servidor/server.log
```

Regras:

- **Loopback não pede PIN.** Quem já está no Termux do próprio aparelho está dentro.
- **`/health` fica aberto**, de propósito — é o que watchdog e monitoramento externo consultam.
- **Cinco erros travam o IP por 15 minutos.** São só 10 mil combinações; sem esse limite, dá pra varrer todas em minutos.
- O cookie é `HttpOnly`, `SameSite=Lax`, válido por 180 dias.

Para desligar (rede confiável, ou atrás de autenticação na borda):

```bash
SERVERBOX_PIN=off node server.js
```

Trocar o PIN: apague o `.j5-pin` e reinicie — um novo é sorteado.

### Resto

- Não abra porta no roteador. Acesso pela rede local ou pela tailnet.
- Headers básicos: `nosniff`, `frame-deny`, `referrer-policy`.
- O PIN viaja em **HTTP puro** na rede local. Contra alguém já dentro do seu Wi-Fi com capacidade de sniffing, ele não protege — para isso, é o Tailscale que faz o trabalho, com o tráfego criptografado.
- A deploy key do celular é **read-only** — se o aparelho for comprometido, ninguém escreve no repositório.
- `.j5-pin`, logs e `nohup.out` ficam fora do git.

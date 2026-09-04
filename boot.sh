#!/data/data/com.termux/files/usr/bin/sh
# Executado pelo Termux:Boot quando o aparelho liga.
#
# Instalar (uma vez, no Termux):
#   mkdir -p ~/.termux/boot
#   ln -sf ~/server-box/boot.sh ~/.termux/boot/start.sh
#   chmod +x ~/server-box/boot.sh
#
# O symlink faz o script se atualizar sozinho junto com o resto do repo.

export PREFIX=/data/data/com.termux/files/usr
export PATH=$PREFIX/bin:$PATH
export HOME=/data/data/com.termux/files/home

mkdir -p "$HOME/servidor"

# Impede o Android de dormir e matar o processo.
termux-wake-lock

# Sobe os serviços do termux-services (sshd, crond) se estiverem habilitados.
[ -f "$PREFIX/etc/profile.d/start-services.sh" ] && . "$PREFIX/etc/profile.d/start-services.sh"

# A rede costuma demorar alguns segundos depois do boot.
sleep 20

# deploy.sh atualiza se houver commit novo e, de qualquer forma, garante o
# server-box no ar — inclusive quando o fetch falha por falta de rede.
sh "$HOME/server-box/deploy.sh" >> "$HOME/servidor/deploy.log" 2>&1

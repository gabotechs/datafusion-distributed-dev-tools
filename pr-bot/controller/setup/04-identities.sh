# Create the isolated controller/build identities and their state directories.
id benchmark-bot >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-bot benchmark-bot
id benchmark-build >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-build benchmark-build
getent group benchmark-cache >/dev/null 2>&1 || groupadd benchmark-cache
usermod --append --groups benchmark-cache benchmark-bot
usermod --append --groups benchmark-cache benchmark-build
install --directory --owner root --group root --mode 0755 /opt/datafusion-pr-bot /opt/datafusion-pr-bot/releases
install --directory --owner benchmark-bot --group benchmark-bot --mode 0700 /var/lib/datafusion-pr-bot
install --directory --owner benchmark-bot --group benchmark-cache --mode 2750 /var/lib/datafusion-pr-work /var/lib/datafusion-pr-work/jobs
install --directory --owner benchmark-build --group benchmark-cache --mode 2770 /var/cache/datafusion-pr-build /var/lib/datafusion-pr-build

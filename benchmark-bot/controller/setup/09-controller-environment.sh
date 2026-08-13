# Write the controller's protected runtime configuration.
cat > /var/lib/datafusion-pr-bot/controller.env <<'ENVIRONMENT'
AWS_REGION={{AWS_REGION}}
GITHUB_REPOSITORY={{GITHUB_REPOSITORY}}
AUTHORIZED_GITHUB_LOGINS={{AUTHORIZED_GITHUB_LOGINS}}
SOURCE_REPOSITORY_URL={{SOURCE_REPOSITORY_URL}}
DATABASE_PATH=/var/lib/datafusion-pr-bot/jobs.db
DATAFUSION_SOURCE_ROOT=/opt/datafusion-pr-bot/datafusion-distributed
KUBECONFIG=/var/lib/datafusion-pr-bot/kubeconfig
FOUNDATION_OUTPUTS_FILE=/var/lib/datafusion-pr-bot/foundation-outputs.json
ENVIRONMENT
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/controller.env
chmod 0600 /var/lib/datafusion-pr-bot/controller.env

# Write the controller's protected runtime configuration.
cat > /var/lib/datafusion-pr-bot/controller.env <<'ENVIRONMENT'
AWS_REGION={{AWS_REGION}}
GITHUB_REPOSITORY={{GITHUB_REPOSITORY}}
AUTHORIZED_GITHUB_LOGINS={{AUTHORIZED_GITHUB_LOGINS}}
SOURCE_REPOSITORY_URL={{SOURCE_REPOSITORY_URL}}
DATABASE_PATH=/var/lib/datafusion-pr-bot/jobs.db
STATE_ROOT=/var/lib/datafusion-pr-bot
BENCHMARK_WORK_ROOT=/var/lib/datafusion-pr-work
BUILD_CACHE_ROOT=/var/cache/datafusion-pr-build
BUILD_CACHE_MAX_GIB=400
KUBECONFIG=/var/lib/datafusion-pr-bot/kubeconfig
FOUNDATION_OUTPUTS_FILE=/var/lib/datafusion-pr-bot/foundation-outputs.json
BENCHMARK_TESTDATA_ROOT=/var/lib/datafusion-pr-bot/testdata
ENVIRONMENT
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/controller.env
chmod 0600 /var/lib/datafusion-pr-bot/controller.env

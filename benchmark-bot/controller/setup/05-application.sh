# Download and install the immutable controller application release.
release=/opt/datafusion-pr-bot/releases/bootstrap
rm --recursive --force ${release}
install --directory --owner root --group root --mode 0755 ${release}
application_temporary=$(mktemp -d)
aws s3 cp s3://{{ARTIFACT_BUCKET_NAME}}/{{APPLICATION_KEY}} ${application_temporary}/application.zip
unzip -q ${application_temporary}/application.zip -d ${release}
chown --recursive root:root ${release}
chmod --recursive go-w ${release}
ln --symbolic --force --no-dereference ${release} /opt/datafusion-pr-bot/current

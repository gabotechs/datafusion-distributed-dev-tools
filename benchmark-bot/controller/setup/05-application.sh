# Download and install the controller through the same release path used by updates.
application_temporary=$(mktemp -d)
aws s3 cp s3://{{ARTIFACT_BUCKET_NAME}}/{{APPLICATION_KEY}} ${application_temporary}/application.zip
unzip -p ${application_temporary}/application.zip controller/install-release \
  > ${application_temporary}/install-release
chmod 0755 ${application_temporary}/install-release
${application_temporary}/install-release \
  ${application_temporary}/application.zip \
  "{{SOURCE_REPOSITORY_URL}}"

# Start the controller after every setup section has completed.
systemctl daemon-reload
systemctl enable --now datafusion-pr-bot.service

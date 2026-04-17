FROM syncthing/syncthing:latest

# Web UI / API
EXPOSE 8384
# Sync protocol (TCP + UDP)
EXPOSE 22000/tcp
EXPOSE 22000/udp

ENV STNORESTART=yes
ENV STNODEFAULTFOLDER=yes
# STGUIAPIKEY is set via Railway environment variables — do not hardcode here

CMD ["/bin/syncthing", \
     "--home=/var/syncthing", \
     "--no-browser", \
     "--no-restart", \
     "--gui-address=0.0.0.0:8384"]

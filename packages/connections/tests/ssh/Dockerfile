FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server curl ca-certificates tar util-linux python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash harness \
    && echo 'harness:qualification-fixture' | chpasswd \
    && mkdir -p /run/sshd \
    && printf '\nPermitRootLogin no\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM no\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]

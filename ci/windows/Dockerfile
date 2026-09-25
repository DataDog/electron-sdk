# escape=`
FROM mcr.microsoft.com/windows/server:ltsc2022

SHELL ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]

# Windows base images do not necessarily expose their system PATH in image metadata.
ENV PATH="C:\node;C:\Program Files\Git\cmd;C:\Program Files\7-Zip;C:\Windows\system32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0"
ENV COREPACK_HOME="C:\corepack" HUSKY="0" YARN_ENABLE_INLINE_BUILDS="true"

COPY install-tools.ps1 C:/install-tools.ps1
RUN C:/install-tools.ps1; Remove-Item C:/install-tools.ps1

WORKDIR C:/w
CMD ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:/source/ci/windows/start.ps1"]

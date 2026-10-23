FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json ./
COPY src/Compute.Domain/ src/Compute.Domain/
COPY src/Compute.Docker/ src/Compute.Docker/
COPY apps/api/ apps/api/
COPY services/computer/src/workspace.py services/computer/src/workspace.py
COPY services/agent/workspace_shell.py services/agent/workspace_shell.py
RUN dotnet publish apps/api/Teammates.Api.csproj -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update && apt-get install -y --no-install-recommends curl tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
COPY db/001_init.sql /migrations/001_init.sql
COPY db/002_reactions.sql /migrations/002_reactions.sql
COPY db/003_v02.sql /migrations/003_v02.sql
COPY db/004_resources.sql /migrations/004_resources.sql
COPY db/005_plugins.sql /migrations/005_plugins.sql
COPY db/006_security.sql /migrations/006_security.sql
COPY db/007_credential_grants.sql /migrations/007_credential_grants.sql
COPY db/008_plugin_catalog.sql /migrations/008_plugin_catalog.sql
COPY db/009_v03.sql /migrations/009_v03.sql
COPY db/010_provider.sql /migrations/010_provider.sql
COPY db/011_devices.sql /migrations/011_devices.sql
COPY db/012_reliability.sql /migrations/012_reliability.sql
COPY db/013_feedback.sql /migrations/013_feedback.sql
COPY db/014_avatar.sql /migrations/014_avatar.sql
COPY db/015_bot_messaging.sql /migrations/015_bot_messaging.sql
COPY db/016_chat_actions.sql /migrations/016_chat_actions.sql
COPY db/017_primary.sql /migrations/017_primary.sql
COPY db/018_bio.sql /migrations/018_bio.sql
COPY db/019_computer_windows.sql /migrations/019_computer_windows.sql
COPY db/020_approval_rules.sql /migrations/020_approval_rules.sql
COPY db/021_desktop_lease.sql /migrations/021_desktop_lease.sql
COPY db/022_tickets_state.sql /migrations/022_tickets_state.sql
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_gcServer=0 \
    DOTNET_GCHeapHardLimit=0x10000000
EXPOSE 8080
ENTRYPOINT ["dotnet", "Teammates.Api.dll"]

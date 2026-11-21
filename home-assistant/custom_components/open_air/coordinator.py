"""Shared state and commands for an Open Air receiver."""

from dataclasses import dataclass
from datetime import timedelta
import logging
from time import monotonic
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import Catalog, OpenAirAuthError, OpenAirClient, OpenAirError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class OpenAirData:
    """The receiver state and preset catalog shared by the entities."""

    state: dict[str, Any]
    catalog: Catalog


type OpenAirConfigEntry = ConfigEntry[OpenAirCoordinator]


class OpenAirCoordinator(DataUpdateCoordinator[OpenAirData]):
    """Poll one Open Air server and refresh after commands."""

    def __init__(
        self, hass: HomeAssistant, entry: OpenAirConfigEntry, client: OpenAirClient
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=timedelta(seconds=5),
            request_refresh_debouncer=Debouncer(hass, _LOGGER, cooldown=0.5, immediate=True),
            always_update=False,
        )
        self.client = client
        self._catalog: Catalog | None = None
        self._catalog_revision: Any = None
        self._catalog_expiry = 0.0

    async def _async_update_data(self) -> OpenAirData:
        """Read radio state and refresh presets after a profile change."""
        try:
            state = await self.client.get_state()
            revision = (state.get("profile") or {}).get("revision")
            if (
                self._catalog is None
                or revision != self._catalog_revision
                or monotonic() >= self._catalog_expiry
            ):
                self._catalog = await self.client.get_catalog()
                self._catalog_revision = revision
                self._catalog_expiry = monotonic() + 60
        except OpenAirAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except OpenAirError as err:
            raise UpdateFailed(str(err)) from err
        return OpenAirData(state, self._catalog)

    async def command(self, endpoint: str, payload: dict[str, Any]) -> None:
        """Apply a radio command and update Home Assistant's entities."""
        try:
            await self.client.run_command(endpoint, payload)
        except OpenAirError as err:
            await self.async_request_refresh()
            raise HomeAssistantError(str(err)) from err
        await self.async_request_refresh()

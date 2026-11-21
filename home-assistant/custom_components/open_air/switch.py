"""Start and stop the CB scanner and configured local range scan."""

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import OpenAirConfigEntry, OpenAirCoordinator
from .entity import OpenAirControl


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add scanner controls."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            OpenAirScanSwitch(coordinator, "cb_scan", "cbScan", "cb-scan"),
            OpenAirScanSwitch(coordinator, "tower_scan", "towerScan", "tower-scan"),
            OpenAirScanSwitch(coordinator, "local_scan", "rfScan", "local-scan"),
        ]
    )


class OpenAirScanSwitch(OpenAirControl, SwitchEntity):
    """Control a scan through its Open Air API endpoint."""

    def __init__(
        self, coordinator: OpenAirCoordinator, key: str, field: str, endpoint: str
    ) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._endpoint = endpoint

    @property
    def is_on(self) -> bool:
        return self.scan_active(self._field)

    async def async_turn_on(self, **kwargs: Any) -> None:
        if not self.is_on:
            await self.coordinator.command(self._endpoint, {"running": True})

    async def async_turn_off(self, **kwargs: Any) -> None:
        if self.is_on:
            await self.coordinator.command(self._endpoint, {"running": False})

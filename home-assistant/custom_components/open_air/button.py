"""A/B switching and local rescanning."""

from homeassistant.components.button import ButtonEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import OpenAirConfigEntry
from .entity import OpenAirControl


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add one-press receiver actions."""
    coordinator = entry.runtime_data
    async_add_entities(
        [OpenAirABSwitch(coordinator, "ab_switch"), OpenAirRescan(coordinator, "rescan_local_area")]
    )


class OpenAirABSwitch(OpenAirControl, ButtonEntity):
    """Swap the current and previous receiver channels."""

    _attr_icon = "mdi:swap-horizontal"

    @property
    def suggested_object_id(self) -> str:
        """Use a stable object ID for the A/B control in the dashboard."""
        return "ab_switch"

    @property
    def available(self) -> bool:
        return super().available and self.previous_source is not None

    async def async_press(self) -> None:
        source = self.previous_source
        if source is None:
            raise HomeAssistantError("Tune two channels before switching between A and B.")
        await self.coordinator.command("ab-switch", {"source": source})


class OpenAirRescan(OpenAirControl, ButtonEntity):
    """Start a scan from the configured local profile."""

    _attr_icon = "mdi:radar"

    @property
    def available(self) -> bool:
        return super().available and not self.scan_active("rfScan")

    async def async_press(self) -> None:
        await self.coordinator.command("local-scan", {"running": True})

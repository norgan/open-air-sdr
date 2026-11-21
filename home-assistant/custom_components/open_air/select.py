"""Preset and receive-mode selectors."""

from collections import Counter

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import HERTZ_PER_MHZ
from .coordinator import OpenAirConfigEntry, OpenAirCoordinator
from .entity import OpenAirControl


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add the receiver selectors."""
    coordinator = entry.runtime_data
    async_add_entities([OpenAirPreset(coordinator, "preset"), OpenAirMode(coordinator, "receive_mode")])


class OpenAirPreset(OpenAirControl, SelectEntity):
    """Choose a preset from the Open Air server."""

    @property
    def _labels(self) -> dict[str, str]:
        sources = self.coordinator.data.catalog.sources
        names = {
            source.id: f"{source.name} · {source.frequency / HERTZ_PER_MHZ:.6f}".rstrip("0").rstrip(".")
            + " MHz"
            for source in sources
        }
        counts = Counter(names.values())
        return {
            source_id: f"{label} [{source_id}]" if counts[label] > 1 else label
            for source_id, label in names.items()
        }

    @property
    def options(self) -> list[str]:
        return list(self._labels.values())

    @property
    def current_option(self) -> str | None:
        return self._labels.get(self.radio.get("source"))

    async def async_select_option(self, option: str) -> None:
        source = next((source_id for source_id, label in self._labels.items() if label == option), None)
        if source is None:
            raise HomeAssistantError("This preset is no longer available.")
        await self.coordinator.command("tune", {"source": source})


class OpenAirMode(OpenAirControl, SelectEntity):
    """Change how the current frequency is decoded."""

    @property
    def available(self) -> bool:
        return super().available and self.frequency_hz is not None

    @property
    def options(self) -> list[str]:
        return list(self.coordinator.data.catalog.modes.values())

    @property
    def current_option(self) -> str | None:
        return self.coordinator.data.catalog.modes.get(self.radio.get("mode"))

    async def async_select_option(self, option: str) -> None:
        modes = self.coordinator.data.catalog.modes
        mode = next((mode_id for mode_id, label in modes.items() if label == option), None)
        frequency = self.frequency_hz
        if mode is None or frequency is None:
            raise HomeAssistantError("Select a valid receive mode and tune a frequency first.")
        if mode != self.radio.get("mode"):
            await self.coordinator.command("tune", {"custom": {"frequency": frequency, "mode": mode}})

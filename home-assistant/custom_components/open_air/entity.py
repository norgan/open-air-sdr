"""Common entity properties for one Open Air receiver."""

from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import numeric
from .const import DOMAIN
from .coordinator import OpenAirCoordinator


class OpenAirEntity(CoordinatorEntity[OpenAirCoordinator]):
    """An entity attached to an Open Air set-up entry."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: OpenAirCoordinator, key: str) -> None:
        super().__init__(coordinator)
        entry_id = coordinator.config_entry.entry_id
        self._attr_translation_key = key
        self._attr_unique_id = f"{entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="Open Air",
            manufacturer="Open Air",
            configuration_url=coordinator.client.origin,
        )

    @property
    def radio(self) -> dict[str, Any]:
        """Return the most recently confirmed receiver state."""
        return self.coordinator.data.state

    @property
    def frequency_hz(self) -> int | None:
        """Return the current frequency in hertz."""
        frequency = numeric(self.radio.get("frequency"))
        return round(frequency) if frequency is not None else None

    @property
    def previous_source(self) -> str | None:
        """Return the previous A/B slot's source ID."""
        previous = (self.radio.get("ab") or {}).get("previous") or {}
        return previous.get("source")

    def scan_active(self, field: str) -> bool:
        """Return whether a scanner is sweeping or holding a channel."""
        return (self.radio.get(field) or {}).get("status") in {"scanning", "holding"}


class OpenAirControl(OpenAirEntity):
    """An Open Air control that needs a receiver connection."""

    @property
    def available(self) -> bool:
        return super().available and self.radio["connected"]

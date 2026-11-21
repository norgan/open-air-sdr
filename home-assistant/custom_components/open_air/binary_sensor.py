"""Receiver and squelch state in Home Assistant."""

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .coordinator import OpenAirConfigEntry, OpenAirCoordinator
from .entity import OpenAirEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add receiver state indicators."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            OpenAirBinarySensor(coordinator, "connected", "connected", BinarySensorDeviceClass.CONNECTIVITY),
            OpenAirBinarySensor(coordinator, "running", "running", BinarySensorDeviceClass.RUNNING),
            OpenAirBinarySensor(coordinator, "squelch_open", "squelch", BinarySensorDeviceClass.OPENING),
        ]
    )


class OpenAirBinarySensor(OpenAirEntity, BinarySensorEntity):
    """A yes/no reading from the receiver."""

    def __init__(
        self,
        coordinator: OpenAirCoordinator,
        key: str,
        field: str,
        device_class: BinarySensorDeviceClass,
    ) -> None:
        super().__init__(coordinator, key)
        self._field = field
        self._attr_device_class = device_class

    @property
    def is_on(self) -> bool | None:
        value = self.radio.get(self._field)
        return value if isinstance(value, bool) else None

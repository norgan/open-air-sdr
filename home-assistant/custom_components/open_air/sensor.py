"""Value sensors for an Open Air receiver."""

from collections.abc import Callable

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.const import UnitOfFrequency
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import numeric
from .const import HERTZ_PER_MHZ
from .coordinator import OpenAirConfigEntry, OpenAirCoordinator
from .entity import OpenAirEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add receiver state sensors."""
    coordinator = entry.runtime_data
    async_add_entities(
        [
            OpenAirSensor(coordinator, "channel", lambda entity: entity.radio.get("sourceName")),
            OpenAirSensor(
                coordinator,
                "frequency",
                lambda entity: entity.frequency_hz / HERTZ_PER_MHZ if entity.frequency_hz else None,
                UnitOfFrequency.MEGAHERTZ,
            ),
            OpenAirSensor(
                coordinator,
                "signal_level",
                lambda entity: numeric(entity.radio.get("channelPower")),
                "dB",
                SensorStateClass.MEASUREMENT,
            ),
            OpenAirSensor(
                coordinator,
                "squelch_threshold",
                lambda entity: numeric(entity.radio.get("squelchThreshold")),
                "dB",
            ),
            OpenAirSensor(
                coordinator,
                "local_area",
                lambda entity: (entity.radio.get("profile") or {}).get("name"),
            ),
            OpenAirSensor(
                coordinator,
                "scan_status",
                lambda entity: (entity.radio.get("rfScan") or {}).get("status"),
            ),
        ]
    )


class OpenAirSensor(OpenAirEntity, SensorEntity):
    """A named reading from the receiver."""

    def __init__(
        self,
        coordinator: OpenAirCoordinator,
        key: str,
        read: Callable[[OpenAirEntity], str | int | float | None],
        unit: str | None = None,
        state_class: SensorStateClass | None = None,
    ) -> None:
        super().__init__(coordinator, key)
        self._read = read
        self._attr_native_unit_of_measurement = unit
        self._attr_state_class = state_class

    @property
    def native_value(self) -> str | int | float | None:
        return self._read(self)

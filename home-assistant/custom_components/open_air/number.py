"""Manual tuning and CB squelch controls."""

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.const import UnitOfFrequency
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .api import numeric
from .const import HERTZ_PER_MHZ, MAX_FREQUENCY_MHZ, MIN_FREQUENCY_MHZ
from .coordinator import OpenAirConfigEntry
from .entity import OpenAirControl


async def async_setup_entry(
    hass: HomeAssistant,
    entry: OpenAirConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Add radio controls with numeric input."""
    coordinator = entry.runtime_data
    async_add_entities(
        [OpenAirFrequency(coordinator, "tune_frequency"), OpenAirCBSquelch(coordinator, "cb_squelch")]
    )


class OpenAirFrequency(OpenAirControl, NumberEntity):
    """Tune the current radio mode to a frequency in MHz."""

    _attr_native_max_value = MAX_FREQUENCY_MHZ
    _attr_native_min_value = MIN_FREQUENCY_MHZ
    _attr_native_step = 1 / HERTZ_PER_MHZ
    _attr_native_unit_of_measurement = UnitOfFrequency.MEGAHERTZ
    _attr_mode = NumberMode.BOX

    @property
    def native_value(self) -> float | None:
        frequency = self.frequency_hz
        return frequency / HERTZ_PER_MHZ if frequency is not None else None

    async def async_set_native_value(self, value: float) -> None:
        modes = self.coordinator.data.catalog.modes
        mode = self.radio.get("mode")
        if mode not in modes:
            mode = "spectrum"
        await self.coordinator.command(
            "tune", {"custom": {"frequency": round(value * HERTZ_PER_MHZ), "mode": mode}}
        )


class OpenAirCBSquelch(OpenAirControl, NumberEntity):
    """Set the CB receiver and scanner's squelch threshold."""

    _attr_native_max_value = 0
    _attr_native_min_value = -100
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "dB"
    _attr_mode = NumberMode.SLIDER

    @property
    def native_value(self) -> int | float | None:
        return numeric(self.radio.get("cbSquelch"))

    async def async_set_native_value(self, value: float) -> None:
        await self.coordinator.command("cb-squelch", {"level": round(value)})

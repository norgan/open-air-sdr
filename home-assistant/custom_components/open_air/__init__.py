"""Connect Home Assistant to an Open Air receiver."""

from homeassistant.const import CONF_TOKEN, CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import OpenAirClient
from .const import CONF_PROXY_PASSWORD, CONF_PROXY_USERNAME
from .coordinator import OpenAirConfigEntry, OpenAirCoordinator

PLATFORMS = (
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
)


async def async_setup_entry(hass: HomeAssistant, entry: OpenAirConfigEntry) -> bool:
    """Set up the radio and its controls."""
    client = OpenAirClient(
        async_get_clientsession(hass),
        entry.data[CONF_URL],
        entry.data[CONF_TOKEN],
        entry.data.get(CONF_PROXY_USERNAME, ""),
        entry.data.get(CONF_PROXY_PASSWORD, ""),
    )
    coordinator = OpenAirCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: OpenAirConfigEntry) -> bool:
    """Unload the receiver entities."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

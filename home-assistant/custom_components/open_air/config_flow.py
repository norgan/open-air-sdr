"""Set up and reauthenticate an Open Air server."""

from typing import Any

import voluptuous as vol
from yarl import URL

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import selector

from .api import OpenAirAuthError, OpenAirClient, OpenAirError, OpenAirProtocolError
from .const import CONF_PROXY_PASSWORD, CONF_PROXY_USERNAME, DOMAIN

_PASSWORD = selector.TextSelector(
    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
)
_AUTH_FIELDS = {
    vol.Required(CONF_TOKEN): _PASSWORD,
    vol.Optional(CONF_PROXY_USERNAME): str,
    vol.Optional(CONF_PROXY_PASSWORD): _PASSWORD,
}
_USER_SCHEMA = vol.Schema({vol.Required(CONF_URL): str, **_AUTH_FIELDS})
_REAUTH_SCHEMA = vol.Schema(_AUTH_FIELDS)


def normalize_origin(raw_url: str) -> URL:
    """Reserve each HTTPS origin for exactly one config entry."""
    url = URL(raw_url.strip())
    if (
        url.scheme != "https"
        or not url.host
        or url.user is not None
        or url.password is not None
        or url.path != "/"
        or url.query_string
        or url.fragment
    ):
        raise ValueError("An HTTPS origin is required.")
    return url.origin()


class OpenAirConfigFlow(ConfigFlow, domain=DOMAIN):
    """Add Open Air to Home Assistant."""

    VERSION = 1

    async def _validate_credentials(self, data: dict[str, Any]) -> dict[str, str]:
        token = data[CONF_TOKEN]
        if not token or "," in token or any(not 33 <= ord(character) <= 126 for character in token):
            return {CONF_TOKEN: "invalid_token"}
        username = data[CONF_PROXY_USERNAME]
        password = data[CONF_PROXY_PASSWORD]
        if bool(username) != bool(password) or ":" in username:
            return {"base": "invalid_proxy_auth"}
        client = OpenAirClient(
            async_get_clientsession(self.hass), data[CONF_URL], token, username, password
        )
        try:
            await client.get_state()
            await client.get_catalog()
        except OpenAirAuthError:
            return {"base": "invalid_auth"}
        except OpenAirProtocolError:
            return {"base": "unsupported_api"}
        except OpenAirError:
            return {"base": "cannot_connect"}
        return {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Connect to a server using its HTTPS address and credentials."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                origin = normalize_origin(user_input[CONF_URL])
            except ValueError:
                errors[CONF_URL] = "invalid_url"
            else:
                await self.async_set_unique_id(str(origin))
                self._abort_if_unique_id_configured()
                data = self._entry_data(str(origin), user_input)
                errors = await self._validate_credentials(data)
                if not errors:
                    return self.async_create_entry(title=f"Open Air ({origin.host})", data=data)

        return self.async_show_form(step_id="user", data_schema=_USER_SCHEMA, errors=errors)

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        """Offer to replace rejected credentials at the same server address."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Check and save the replacement credentials."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data = self._entry_data(entry.data[CONF_URL], user_input)
            errors = await self._validate_credentials(data)
            if not errors:
                return self.async_update_reload_and_abort(entry, data_updates=data)

        schema = self.add_suggested_values_to_schema(
            _REAUTH_SCHEMA, {CONF_PROXY_USERNAME: entry.data.get(CONF_PROXY_USERNAME, "")}
        )
        return self.async_show_form(step_id="reauth_confirm", data_schema=schema, errors=errors)

    @staticmethod
    def _entry_data(origin: str, user_input: dict[str, Any]) -> dict[str, str]:
        return {
            CONF_URL: origin,
            CONF_TOKEN: user_input[CONF_TOKEN].strip(),
            CONF_PROXY_USERNAME: user_input.get(CONF_PROXY_USERNAME, ""),
            CONF_PROXY_PASSWORD: user_input.get(CONF_PROXY_PASSWORD, ""),
        }

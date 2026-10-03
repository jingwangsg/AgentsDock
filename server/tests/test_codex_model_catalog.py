"""Parser and durable store for the Codex app-server ``model/list`` mirror."""
import json
from pathlib import Path
import stat
import tempfile
import unittest

import codex_model_catalog as catalog
import native_model_store

# Shape captured from codex-cli 0.157.1 app-server protocol v2 ``model/list``;
# unrelated fields trimmed, one hidden row and one deprecated field kept.
MODEL_LIST = {
    "data": [
        {
            "id": "gpt-6-sol", "model": "gpt-6-sol", "upgrade": None, "upgradeInfo": None,
            "availabilityNux": None, "displayName": "GPT-6-Sol",
            "description": "Workhorse model for coding and everyday work.",
            "modelSpecialty": None, "hidden": False,
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low", "description": "Fast responses with lighter reasoning"},
                {"reasoningEffort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
                {"reasoningEffort": "ultra", "description": "Maximum reasoning with automatic task delegation"},
            ],
            "defaultReasoningEffort": "medium", "inputModalities": ["text", "image"],
            "supportsPersonality": False, "multiAgentVersion": "v2", "additionalSpeedTiers": [],
            "serviceTiers": [], "defaultServiceTier": None,
            "availableAccessPrograms": {"cyber": ["standard"]}, "isDefault": True,
        },
        {
            "id": "gpt-reserve", "model": "gpt-reserve", "displayName": "GPT-Reserve",
            "description": "Reserved capacity.", "hidden": True,
            "supportedReasoningEfforts": [{"reasoningEffort": "medium", "description": ""}],
            "defaultReasoningEffort": "medium", "isDefault": False,
        },
        {
            "id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "displayName": "GPT-5.6-Sol",
            "description": "Previous generation.", "hidden": False,
            "supportedReasoningEfforts": [
                {"reasoningEffort": "high", "description": "Greater reasoning depth for complex problems"},
            ],
            "defaultReasoningEffort": "high", "serviceTiers": [
                {"id": "fast", "name": "Fast", "description": "Priority processing"},
            ],
            "defaultServiceTier": "fast", "isDefault": False,
        },
    ],
    "nextCursor": None,
}

PARSED = [
    {
        "value": "gpt-6-sol", "label": "GPT-6-Sol",
        "description": "Workhorse model for coding and everyday work.",
        "efforts": [
            {"value": "low", "description": "Fast responses with lighter reasoning"},
            {"value": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
            {"value": "ultra", "description": "Maximum reasoning with automatic task delegation"},
        ],
        "default_effort": "medium", "is_default": True,
    },
    {
        "value": "gpt-5.6-sol", "label": "GPT-5.6-Sol", "description": "Previous generation.",
        "efforts": [{"value": "high", "description": "Greater reasoning depth for complex problems"}],
        "default_effort": "high", "service_tier": "fast",
    },
]


class ModelListParserTests(unittest.TestCase):
    def test_rows_keep_cli_order_omit_hidden_and_mark_the_default(self):
        self.assertEqual(catalog.parse_model_list(MODEL_LIST), PARSED)

    def test_missing_schema_is_unavailable_but_an_empty_list_is_authoritative(self):
        for bad in (None, [], {}, {"data": None}, {"data": {}}):
            with self.subTest(bad=bad):
                with self.assertRaises(catalog.CodexModelCatalogUnavailable):
                    catalog.parse_model_list(bad)
        self.assertEqual(catalog.parse_model_list({"data": []}), [])
        with self.assertRaises(catalog.CodexModelCatalogUnavailable):
            catalog.parse_model_list({"data": [{"model": "m"}] * (catalog.MAX_MODELS + 1)})

    def test_bad_rows_duplicates_and_unsafe_text_are_not_forwarded(self):
        rows = catalog.parse_model_list({"data": [
            "not a row",
            {"model": "bad id with spaces", "displayName": "Bad"},
            {"model": "dup", "displayName": "First", "supportedReasoningEfforts": []},
            {"model": "dup", "displayName": "Second", "supportedReasoningEfforts": []},
            {"model": "odd", "displayName": "Bad\nlabel", "description": "x" * 201,
             "supportedReasoningEfforts": [
                 {"reasoningEffort": "Not Valid!", "description": "dropped"},
                 {"reasoningEffort": "low", "description": "Ctrl\x00char"},
                 {"reasoningEffort": "low", "description": "duplicate"},
             ],
             "defaultReasoningEffort": "unsupported", "defaultServiceTier": "bad\ttier"},
        ]})
        self.assertEqual(rows, [
            {"value": "dup", "label": "First", "efforts": []},
            {"value": "odd", "label": "odd", "efforts": [{"value": "low"}]},
        ])
        with self.assertRaises(catalog.CodexModelCatalogUnavailable):
            catalog.parse_model_list({"data": [{"displayName": "no id"}]})

    def test_hidden_rows_count_as_valid_so_an_all_hidden_list_is_empty_not_invalid(self):
        self.assertEqual(catalog.parse_model_list({"data": [MODEL_LIST["data"][1]]}), [])


class DurableStoreTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.store = self.root / "state/codex-native-models.json"
        self.previous = catalog._STORE.path
        catalog.configure_native_models_store(self.store)
        self.addCleanup(catalog.configure_native_models_store, self.previous)
        catalog.clear_native_models()
        self.addCleanup(catalog.clear_native_models)
        self.identity = ("/opt/codex", 1, 2, 3, 4, "codex-cli 0.157.1")
        self.key = catalog.native_catalog_key(self.identity, ["/home/.codex", "chatgpt", "acct", "sub"])

    def test_key_is_hex_and_follows_binary_and_account(self):
        self.assertRegex(self.key, r"^[0-9a-f]{64}$")
        self.assertEqual(self.key, catalog.native_catalog_key(self.identity, ["/home/.codex", "chatgpt", "acct", "sub"]))
        self.assertNotEqual(self.key, catalog.native_catalog_key((*self.identity[:-1], "codex-cli 0.158.0"), ["/home/.codex", "chatgpt", "acct", "sub"]))
        self.assertNotEqual(self.key, catalog.native_catalog_key(self.identity, ["/home/.codex", "chatgpt", "other", "sub"]))
        self.assertNotEqual(self.key, catalog.native_catalog_key(self.identity, None))

    def test_round_trip_survives_memory_loss_with_a_private_file(self):
        self.assertIsNone(catalog.cached_native_models(self.key))
        catalog.remember_native_models(PARSED, key=self.key)
        self.assertEqual(stat.S_IMODE(self.store.stat().st_mode), 0o600)
        catalog._STORE.cache.clear()  # A hub restart loses memory, not the file.
        rows = catalog.cached_native_models(self.key)
        self.assertEqual(rows, PARSED)
        rows[0]["efforts"].clear()  # Callers get copies, never the cached rows.
        self.assertEqual(catalog.cached_native_models(self.key), PARSED)
        self.assertIsNone(catalog.cached_native_models("0" * 64))

    def test_entries_are_bounded_and_the_newest_survive(self):
        keys = [catalog.native_catalog_key(self.identity, ["acct", str(n)]) for n in range(catalog.CACHE_LIMIT + 2)]
        for key in keys:
            catalog.remember_native_models(PARSED, key=key)
        catalog._STORE.cache.clear()
        stored = json.loads(self.store.read_text())
        self.assertEqual(len(stored), catalog.CACHE_LIMIT)
        self.assertIsNone(catalog.cached_native_models(keys[0]))
        self.assertEqual(catalog.cached_native_models(keys[-1]), PARSED)

    def test_damaged_file_is_ignored_and_repaired(self):
        self.store.parent.mkdir()
        for damaged in ("not json", json.dumps([]), json.dumps({"short-key": PARSED}),
                        json.dumps({self.key: [{"value": "bad id", "label": "x", "efforts": []}]}),
                        json.dumps({self.key: [{"value": "ok", "label": "x", "efforts": "not a list"}]}),
                        json.dumps({self.key: "rows"})):
            with self.subTest(damaged=damaged[:24]):
                self.store.write_text(damaged)
                catalog._STORE.cache.clear()
                self.assertIsNone(catalog.cached_native_models(self.key))
        self.store.write_text("x" * (native_model_store.STORE_MAX_BYTES + 1))
        self.assertIsNone(catalog.cached_native_models(self.key))
        catalog.remember_native_models(PARSED, key=self.key)
        catalog._STORE.cache.clear()
        self.assertEqual(catalog.cached_native_models(self.key), PARSED)

    def test_invalid_rows_are_rejected_before_they_reach_the_store(self):
        with self.assertRaises(catalog.CodexModelCatalogUnavailable):
            catalog.remember_native_models([{"value": "bad id", "label": "x", "efforts": []}], key=self.key)
        self.assertFalse(self.store.exists())

    def test_clear_removes_the_file_and_unwritable_store_keeps_memory(self):
        catalog.remember_native_models(PARSED, key=self.key)
        catalog.clear_native_models()
        self.assertFalse(self.store.exists())
        self.assertIsNone(catalog.cached_native_models(self.key))
        blocker = self.root / "blocked"
        blocker.write_text("")
        catalog.configure_native_models_store(blocker / "codex-native-models.json")
        catalog.remember_native_models(PARSED, key=self.key)
        self.assertEqual(catalog.cached_native_models(self.key), PARSED)


if __name__ == "__main__":
    unittest.main()

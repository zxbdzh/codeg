import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from hermes_state import SessionDB

action, database_path = sys.argv[2], Path(sys.argv[3])
database = SessionDB(database_path, read_only=action == "read")
if action == "seed":
    database.create_session("hermes-undo", "cli", model="test-model")
    database.create_session("other-hermes", "cli", model="test-model")
    for role, text, timestamp in [
        ("user", "Keep Hermes question", 1794877201),
        ("assistant", "Keep Hermes answer", 1794877202),
        ("user", "Undo Hermes question", 1794877260),
        ("assistant", "Undo Hermes answer", 1794877261),
    ]:
        database.append_message("hermes-undo", role, text, timestamp=timestamp)
    database.append_message("other-hermes", "user", "Keep other Hermes session", timestamp=1794877261)
else:
    messages = database.get_messages_as_conversation("hermes-undo")
    print(json.dumps({"roles": [message["role"] for message in messages]}))
database.close()

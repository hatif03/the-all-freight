.PHONY: run-backend run-detector run-sentinel run-logistics run-carrier run-finance run-procurement run-customer-impact run-dissent run-agents run-all setup help

PYTHONPATH_VAR = PYTHONPATH=$(shell pwd)/backend:$(shell pwd)/agents:$(shell pwd)

help:
	@echo "The All Freight — Ops Room Multi-Agent Orchestration Commands:"
	@echo "  make run-backend         - Run FastAPI backend locally"
	@echo "  make run-detector        - Run AIS ingestion disruption detector"
	@echo "  make run-sentinel        - Run Sentinel Room Orchestrator agent"
	@echo "  make run-logistics       - Run Logistics agent (LangGraph)"
	@echo "  make run-carrier         - Run Carrier agent (PydanticAI)"
	@echo "  make run-finance         - Run Finance agent"
	@echo "  make run-procurement     - Run Procurement agent (CrewAI)"
	@echo "  make run-customer-impact - Run Customer-Impact agent"
	@echo "  make run-dissent         - Run Dissent agent"
	@echo "  make run-agents          - Run all 7 agents simultaneously (background)"
	@echo "  make run-all             - Run backend, detector, and all agents together using overmind/honcho/foreman"

run-backend:
	cd backend && uv run uvicorn main:app --reload --host 0.0.0.0 --port 8000

run-detector:
	cd backend && $(PYTHONPATH_VAR) uv run python detector.py

run-sentinel:
	cd agents && $(PYTHONPATH_VAR) uv run python sentinel/main.py

run-logistics:
	cd agents && $(PYTHONPATH_VAR) uv run python logistics/main.py

run-carrier:
	cd agents && $(PYTHONPATH_VAR) uv run python carrier/main.py

run-finance:
	cd agents && $(PYTHONPATH_VAR) uv run python finance/main.py

run-procurement:
	cd agents && $(PYTHONPATH_VAR) uv run python procurement/main.py

run-customer-impact:
	cd agents && $(PYTHONPATH_VAR) uv run python customer_impact/main.py

run-dissent:
	cd agents && $(PYTHONPATH_VAR) uv run python dissent/main.py

run-agents:
	@echo "Starting all 7 agents..."
	$(PYTHONPATH_VAR) uv run python agents/sentinel/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/logistics/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/carrier/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/finance/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/procurement/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/customer_impact/main.py & \
	$(PYTHONPATH_VAR) uv run python agents/dissent/main.py & \
	wait

run-all:
	@if command -v overmind >/dev/null 2>&1; then \
		overmind start -f Procfile.dev; \
	elif command -v honcho >/dev/null 2>&1; then \
		honcho start -f Procfile.dev; \
	elif command -v foreman >/dev/null 2>&1; then \
		foreman start -f Procfile.dev; \
	else \
		echo "No process manager (overmind, honcho, foreman) found. Starting in parallel..."; \
		make run-backend & \
		sleep 2; \
		make run-detector & \
		make run-agents; \
	fi

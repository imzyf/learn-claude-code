SESSION_TARGET := $(firstword $(subst _, ,$(notdir $(CURDIR))))

.PHONY: $(SESSION_TARGET) debug

$(SESSION_TARGET):
	$(MAKE) -C .. $(SESSION_TARGET) $(if $(filter debug,$(MAKECMDGOALS)),debug)

debug: $(SESSION_TARGET)

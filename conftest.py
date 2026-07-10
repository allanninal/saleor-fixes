# Dummy environment so the scripts import cleanly during tests.
# The tests only exercise pure functions, so no real credentials are ever used.
import os

os.environ.setdefault('SALEOR_API_URL', 'https://demo.saleor.io/graphql/')
os.environ.setdefault('SALEOR_AUTH_TOKEN', 'token_dummy')
os.environ.setdefault('DRY_RUN', 'true')
